import express from "express";
import { body, validationResult } from "express-validator";
import { v4 as uuidv4 } from "uuid";
import { authenticateToken } from "../middleware/auth.js";
import {
  authenticateApiKey,
  requirePermission,
  trackUsage,
} from "../middleware/tenant.js";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import embeddingService from "../services/embedding.js";
import externalContextService from "../services/externalContext.js";
import handoffService from "../services/handoff.js";
import { detectSupportIntent } from "../services/intent.js";
import llmProvider from "../services/llmProvider.js";
import supportTools from "../services/supportTools.js";

const router = express.Router();

// Start new conversation (API endpoint)
router.post(
  "/start",
  authenticateApiKey,
  requirePermission("chat:write"),
  trackUsage("apiCalls"),
  [
    body("visitorId").optional().trim(),
    body("metadata").optional().isObject(),
    body("visitor").optional().isObject(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array(),
        });
      }

      const { visitorId, metadata, visitor } = req.body;
      const tenantId = req.tenant._id;

      const sessionId = uuidv4();
      const conversation = new Conversation({
        tenantId,
        sessionId,
        visitorId: visitorId || uuidv4(),
        channel: "api",
        metadata: metadata || {},
        visitor: visitor || {},
      });

      await conversation.save();

      // Send welcome message
      const welcomeMessage = req.tenant.settings.chatWidget.welcomeMessage;

      const message = new Message({
        conversationId: conversation._id,
        tenantId,
        role: "assistant",
        content: welcomeMessage,
        metadata: {
          messageType: "text",
          isWelcome: true,
        },
      });

      await message.save();

      // Track usage
      await req.tenant.incrementUsage("conversations");

      res.status(201).json({
        sessionId,
        conversationId: conversation._id,
        message: welcomeMessage,
        visitor: conversation.visitor,
      });
    } catch (error) {
      console.error("Start conversation error:", error);
      res.status(500).json({ error: "Failed to start conversation" });
    }
  },
);

// Send message (API endpoint)
router.post(
  "/message",
  authenticateApiKey,
  requirePermission("chat:write"),
  trackUsage("apiCalls"),
  [
    body("sessionId").trim().isLength({ min: 1 }),
    body("message").trim().isLength({ min: 1 }),
    body("visitorData").optional().isObject(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array(),
        });
      }

      const { sessionId, message: userMessage, visitorData } = req.body;
      const tenantId = req.tenant._id;

      // Find conversation
      const conversation = await Conversation.findOne({
        sessionId,
        tenantId,
        status: { $in: ["active", "transferred"] },
      });

      if (!conversation) {
        return res
          .status(404)
          .json({ error: "Conversation not found or ended" });
      }

      // Update visitor data if provided
      if (visitorData) {
        conversation.visitor = { ...conversation.visitor, ...visitorData };
        await conversation.save();
      }

      // Save user message
      const userMsg = new Message({
        conversationId: conversation._id,
        tenantId,
        role: "user",
        content: userMessage,
        metadata: { messageType: "text" },
      });
      await userMsg.save();

      // Check if conversation is assigned to human agent
      if (conversation.assignedAgent) {
        // Forward to human agent via Socket.IO
        const io = req.app.get("io");
        if (io) {
          io.to(`agent-${conversation.assignedAgent}`).emit(
            "customer-message",
            {
              conversationId: conversation._id,
              sessionId,
              message: userMessage,
              visitor: conversation.visitor,
              timestamp: new Date(),
            },
          );
        }

        return res.json({
          sessionId,
          message: "Message forwarded to agent",
          status: "transferred",
          assignedAgent: conversation.assignedAgent,
        });
      }

      // Check for handoff keywords
      const handoffKeywords = req.tenant.settings.handoff.triggerKeywords || [
        "human",
        "agent",
        "person",
        "representative",
        "help",
        "support",
      ];

      const needsHandoff = handoffKeywords.some((keyword) =>
        userMessage.toLowerCase().includes(keyword.toLowerCase()),
      );

      if (needsHandoff && req.tenant.settings.handoff.enabled) {
        try {
          const handoffResult = await handoffService.requestHandoff(
            conversation._id,
            "Customer requested human assistance",
            "medium",
          );

          return res.json({
            sessionId,
            message:
              handoffResult.status === "assigned"
                ? `I'm connecting you with ${handoffResult.agent.name}. They'll be with you shortly!`
                : "I'm looking for an available agent to help you. Please hold on.",
            status: handoffResult.status,
            handoff: handoffResult,
          });
        } catch (handoffError) {
          console.warn(
            "Handoff failed, continuing with AI:",
            handoffError.message,
          );
          // Continue with AI response
        }
      }

      // Generate AI response
      const startTime = Date.now();

      // Get conversation history
      const recentMessages = await Message.getConversationHistory(
        conversation._id,
        10,
      );

      // Search knowledge base
      const knowledgeResults = await embeddingService.findSimilarKnowledge(
        tenantId,
        userMessage,
        3,
      );

      // Detect support intent and attempt tool execution (tenant-configured)
      const intent = detectSupportIntent(userMessage);
      const toolResult = await supportTools.execute(intent, {
        tenant: req.tenant,
        message: userMessage,
        sessionId,
        visitor: conversation.visitor,
      });

      // Build context
      let contextPrompt = req.tenant.settings.ai.systemPrompt;

      if (knowledgeResults.length > 0) {
        contextPrompt += "\n\nRelevant knowledge:\n";
        knowledgeResults.forEach((result) => {
          contextPrompt += `Q: ${result.item.question}\nA: ${result.item.answer}\n\n`;
        });
      }

      if (toolResult) {
        contextPrompt += `\n\nSupport tool (${toolResult.type}) findings:`;
        if (toolResult.context) contextPrompt += `\n${toolResult.context}`;
        if (toolResult.snippets?.length) {
          contextPrompt +=
            "\n" +
            toolResult.snippets.map((s, i) => `(${i + 1}) ${s}`).join("\n");
        }
        contextPrompt += "\n";
      }

      // Fetch tenant-specific external context (e.g., from tenant's website/database)
      try {
        const external = await externalContextService.fetchContextForMessage(
          req.tenant,
          {
            query: userMessage,
            sessionId,
            visitor: conversation.visitor,
          },
        );
        if (external) {
          contextPrompt += "\n\nTenant external data:";
          if (external.context) {
            contextPrompt += `\n${external.context}`;
          }
          if (external.snippets && external.snippets.length > 0) {
            contextPrompt +=
              "\n" +
              external.snippets.map((s, i) => `(${i + 1}) ${s}`).join("\n");
          }
          contextPrompt += "\n";
        }
      } catch (extErr) {
        console.warn(
          "External context integration error:",
          extErr?.message || extErr,
        );
      }

      // Prepare messages for LLM
      const messages = recentMessages.map((msg) => ({
        role: msg.role === "agent" ? "assistant" : msg.role,
        content: msg.content,
      }));

      // Add current user message
      messages.push({
        role: "user",
        content: userMessage,
      });

      // Generate response
      const llmResponse = await llmProvider.generateResponse(messages, {
        systemPrompt: contextPrompt,
        temperature: req.tenant.settings.ai.temperature,
        maxTokens: req.tenant.settings.ai.maxTokens,
      });

      const processingTime = Date.now() - startTime;

      // Save assistant message
      const assistantMsg = new Message({
        conversationId: conversation._id,
        tenantId,
        role: "assistant",
        content: llmResponse.content,
        metadata: {
          messageType: "text",
          confidence: 0.8, // You could calculate this based on knowledge match
          processingTime,
          usedKnowledge: knowledgeResults.map((result) => ({
            kbItemId: result.item._id,
            similarity: result.similarity,
          })),
          llmResponse: {
            model: llmResponse.model,
            tokens: llmResponse.usage?.total_tokens,
            finishReason: llmResponse.finishReason,
          },
        },
      });

      await assistantMsg.save();

      // Update knowledge usage
      for (const result of knowledgeResults) {
        await result.item.updateUsage();
      }

      res.json({
        sessionId,
        message: llmResponse.content,
        metadata: {
          processingTime,
          knowledgeUsed: knowledgeResults.length,
          confidence: assistantMsg.metadata.confidence,
        },
      });
    } catch (error) {
      console.error("Send message error:", error);

      const message = error?.message || "Failed to process message";
      const isLlmAuthError = message.includes(
        "LLM authentication failed (401)",
      );
      const isLlmConfigError =
        message.includes("Missing LLM API key") ||
        message.includes("Global fetch is unavailable");
      const isLlmUpstreamError = message.includes("LLM API error:");

      if (isLlmAuthError) {
        return res.status(502).json({
          error: "LLM provider authentication failed",
          details: message,
        });
      }

      if (isLlmConfigError || isLlmUpstreamError) {
        return res.status(502).json({
          error: "LLM provider unavailable",
          details: message,
        });
      }

      res.status(500).json({ error: "Failed to process message" });
    }
  },
);

// Get conversation history (API endpoint)
router.get(
  "/:sessionId/history",
  authenticateApiKey,
  requirePermission("chat:read"),
  trackUsage("apiCalls"),
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { limit = 50 } = req.query;
      const tenantId = req.tenant._id;

      const conversation = await Conversation.findOne({ sessionId, tenantId });

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const messages = await Message.getConversationHistory(
        conversation._id,
        parseInt(limit),
      );

      res.json({
        sessionId,
        conversationId: conversation._id,
        status: conversation.status,
        messages: messages.map((msg) => ({
          id: msg._id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.createdAt,
          metadata: msg.metadata,
        })),
        visitor: conversation.visitor,
        assignedAgent: conversation.assignedAgent,
      });
    } catch (error) {
      console.error("Get conversation history error:", error);
      res.status(500).json({ error: "Failed to get conversation history" });
    }
  },
);

// Get conversation history for dashboard (token auth)
router.get(
  "/admin/:conversationId/history",
  authenticateToken,
  async (req, res) => {
    try {
      const { conversationId } = req.params;
      const tenantId = req.tenant._id;

      const conversation = await Conversation.findOne({
        _id: conversationId,
        tenantId,
      });

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const messages = await Message.getConversationHistory(
        conversation._id,
        200,
      );

      res.json({
        sessionId: conversation.sessionId,
        conversationId: conversation._id,
        status: conversation.status,
        messages: messages.map((msg) => ({
          id: msg._id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.createdAt,
          metadata: msg.metadata,
        })),
        visitor: conversation.visitor,
        assignedAgent: conversation.assignedAgent,
      });
    } catch (error) {
      console.error("Admin get history error:", error);
      res.status(500).json({ error: "Failed to get conversation history" });
    }
  },
);

// End conversation
router.post(
  "/:sessionId/end",
  authenticateApiKey,
  requirePermission("chat:write"),
  trackUsage("apiCalls"),
  [
    body("reason").optional().trim(),
    body("satisfaction").optional().isObject(),
  ],
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { reason, satisfaction } = req.body;
      const tenantId = req.tenant._id;

      const conversation = await Conversation.findOne({ sessionId, tenantId });

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Add satisfaction rating if provided
      if (satisfaction && satisfaction.rating) {
        await conversation.addSatisfactionRating(
          satisfaction.rating,
          satisfaction.feedback,
        );
      }

      // End conversation
      await conversation.end({
        resolution: reason || "Conversation ended by API",
      });

      // Add closing message
      const closingMessage = new Message({
        conversationId: conversation._id,
        tenantId,
        role: "system",
        content:
          "This conversation has been ended. Thank you for using our service!",
        metadata: {
          messageType: "system",
          reason: reason || "api_end",
        },
      });

      await closingMessage.save();

      res.json({
        sessionId,
        message: "Conversation ended successfully",
        summary: conversation.summary,
        satisfaction: conversation.satisfaction,
      });
    } catch (error) {
      console.error("End conversation error:", error);
      res.status(500).json({ error: "Failed to end conversation" });
    }
  },
);

// Get conversations (dashboard)
router.get("/conversations", authenticateToken, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const tenantId = req.tenant._id;

    const query = { tenantId };
    if (status) query.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [conversations, total] = await Promise.all([
      Conversation.find(query)
        .populate("assignedAgent", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Conversation.countDocuments(query),
    ]);

    // Get message counts for each conversation
    const conversationsWithCounts = await Promise.all(
      conversations.map(async (conv) => {
        const messageCount = await Message.countDocuments({
          conversationId: conv._id,
        });
        return {
          ...conv.toObject(),
          messageCount,
        };
      }),
    );

    res.json({
      conversations: conversationsWithCounts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Get conversations error:", error);
    res.status(500).json({ error: "Failed to get conversations" });
  }
});

// Request handoff (API endpoint)
router.post(
  "/:sessionId/handoff",
  authenticateApiKey,
  requirePermission("chat:write"),
  trackUsage("apiCalls"),
  [
    body("reason").trim().isLength({ min: 1 }),
    body("priority").optional().isIn(["low", "medium", "high", "urgent"]),
    body("department").optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array(),
        });
      }

      const { sessionId } = req.params;
      const { reason, priority, department } = req.body;
      const tenantId = req.tenant._id;

      const conversation = await Conversation.findOne({ sessionId, tenantId });

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const handoffResult = await handoffService.requestHandoff(
        conversation._id,
        reason,
        priority || "medium",
        department,
      );

      res.json({
        sessionId,
        handoff: handoffResult,
      });
    } catch (error) {
      console.error("Request handoff error:", error);
      res.status(500).json({ error: "Failed to request handoff" });
    }
  },
);

// Agent accepts handoff
router.post(
  "/:conversationId/agent/accept",
  authenticateToken,
  [body("message").optional().trim()],
  async (req, res) => {
    try {
      const { conversationId } = req.params;
      const agentId = req.user._id.toString();
      const { message } = req.body;

      const result = await handoffService.acceptHandoff(
        conversationId,
        agentId,
        message,
      );
      res.json({ success: true, ...result });
    } catch (error) {
      console.error("Agent accept handoff error:", error);
      res.status(500).json({ error: "Failed to accept handoff" });
    }
  },
);

// Agent assigns themselves to an unassigned conversation
router.post(
  "/:conversationId/agent/assign",
  authenticateToken,
  async (req, res) => {
    try {
      const { conversationId } = req.params;
      const agentId = req.user._id.toString();
      const io = req.app.get("io");

      const conversation = await Conversation.findById(conversationId);
      if (
        !conversation ||
        conversation.tenantId.toString() !== req.tenant._id.toString()
      ) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      if (conversation.assignedAgent) {
        // Already assigned; allow if same agent
        if (conversation.assignedAgent.toString() !== agentId) {
          return res
            .status(409)
            .json({ error: "Conversation already assigned to another agent" });
        }
        return res.json({ success: true, assigned: true });
      }

      // Assign and set status
      await conversation.assignToAgent(agentId, {
        reason: "Agent claimed conversation",
        priority: "medium",
      });

      // Send intro message and emit join event
      await handoffService.addAgentMessage(
        conversationId,
        agentId,
        `Hi! I'm ${req.user.name}, I'll help you now.`,
      );
      if (io) {
        io.to(`conversation-${conversationId}`).emit("agent-joined", {
          agent: { id: agentId, name: req.user.name },
        });
      }

      res.json({ success: true, assigned: true });
    } catch (error) {
      console.error("Agent assign conversation error:", error);
      res.status(500).json({ error: "Failed to assign conversation" });
    }
  },
);

// Agent sends message to customer
router.post(
  "/:conversationId/agent/message",
  authenticateToken,
  [body("content").trim().isLength({ min: 1 })],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array(),
        });
      }

      const { conversationId } = req.params;
      const agentId = req.user._id.toString();
      const { content } = req.body;

      // Persist agent message
      await handoffService.addAgentMessage(conversationId, agentId, content);

      // Emit to conversation room
      const io = req.app.get("io");
      if (io) {
        io.to(`conversation-${conversationId}`).emit("new-message", {
          role: "agent",
          content,
          metadata: { userId: agentId, messageType: "text" },
          timestamp: new Date(),
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Agent send message error:", error);
      res.status(500).json({ error: "Failed to send agent message" });
    }
  },
);

export default router;

import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createServer } from "http";
import { Server } from "socket.io";
import { connectDB } from "./config/db.js";
import { loadEnv } from "./config/env.js";
import { errorHandler } from "./utils/error.js";

// Route imports
import apiKeyRoutes from "./routes/apiKeyRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import kbRoutes from "./routes/kbRoutes.js";
import tenantRoutes from "./routes/tenantRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import handoffService from "./services/handoff.js";

// Load environment variables
loadEnv();

const app = express();
const server = createServer(app);

// CORS configuration - Allow all origins
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  }),
);

// Socket.IO config - Allow all origins
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false,
  },
});

// Connect to MongoDB - only in non-serverless mode
if (!process.env.VERCEL) {
  connectDB();
}

// Security middleware
app.use(helmet());
app.use(compression());

// CORS configuration

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Ensure DB connection in serverless environment
if (process.env.VERCEL) {
  app.use(async (req, res, next) => {
    try {
      await connectDB();
      next();
    } catch (error) {
      console.error("DB connection error:", error.message);
      next(); // Continue anyway for health checks
    }
  });
}

// Rate limiting - DISABLED for testing
// app.use(globalRateLimit);

// Handle preflight requests - Allow all origins
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, Origin, X-Requested-With, Accept",
  );
  res.header("Access-Control-Allow-Credentials", "false");
  res.sendStatus(200);
});

// Root route - must come before other routes
app.get("/", (req, res) =>
  res.json({ message: "Welcome to SuhTech AI ChatBot Backend!" }),
);

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "production",
    version: "1.0.0",
  });
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/tenant", tenantRoutes);
app.use("/api/keys", apiKeyRoutes);
app.use("/api/kb", kbRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/webhook", webhookRoutes);

// Socket.IO for real-time features (disabled in serverless)
if (!process.env.VERCEL) {
  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("join-tenant", (tenantId) => {
      socket.join(`tenant-${tenantId}`);
      console.log(`Socket ${socket.id} joined tenant ${tenantId}`);
    });

    socket.on("agent-online", (data) => {
      socket.join(`agent-${data.agentId}`);
      socket.to(`tenant-${data.tenantId}`).emit("agent-status", {
        agentId: data.agentId,
        status: "online",
      });
      console.log(`Agent ${data.agentId} is online`);
      // Track online agent for auto-assign and process queued handoffs
      try {
        handoffService.setAgentOnline(data.tenantId, data.agentId);
        setImmediate(() => handoffService.processQueue());
      } catch (e) {
        console.error("Failed to mark agent online:", e.message);
      }
    });

    socket.on("agent-offline", (data) => {
      socket.leave(`agent-${data.agentId}`);
      socket.to(`tenant-${data.tenantId}`).emit("agent-status", {
        agentId: data.agentId,
        status: "offline",
      });
      console.log(`Agent ${data.agentId} is offline`);
      try {
        handoffService.setAgentOffline(data.tenantId, data.agentId);
      } catch (e) {
        console.error("Failed to mark agent offline:", e.message);
      }
    });

    socket.on("join-conversation", (conversationId) => {
      socket.join(`conversation-${conversationId}`);
      console.log(`Socket ${socket.id} joined conversation ${conversationId}`);
    });

    socket.on("leave-conversation", (conversationId) => {
      socket.leave(`conversation-${conversationId}`);
      console.log(`Socket ${socket.id} left conversation ${conversationId}`);
    });

    socket.on("chat-message", (data) => {
      socket
        .to(`conversation-${data.conversationId}`)
        .emit("new-message", data);
    });

    socket.on("handoff-notification", (data) => {
      // Broadcast handoff notifications to all agents in the tenant
      socket.to(`tenant-${data.tenantId}`).emit("new-handoff", data);
      console.log(
        `Handoff notification sent to tenant ${data.tenantId}:`,
        data,
      );
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  // Make io available to routes
  app.set("io", io);
  // Inject io into services that need it
  handoffService.setSocketIO(io);
}

// Global error handlers to prevent crashes
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

// Error handling
app.use(errorHandler);

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    error: "Route not found",
    path: req.originalUrl,
  });
});

const PORT = process.env.PORT || 3000;

// Only start server in non-serverless mode
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`🔗 Frontend URL: ${process.env.FRONTEND_URL || "not set"}`);
  });
}

// Export for Vercel serverless
export default app;

import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { authenticateApiKey, checkUsageLimit, requirePermission } from '../middleware/tenant.js';
import KBItem from '../models/KBItem.js';
import embeddingService from '../services/embedding.js';

const router = express.Router();

// Get knowledge base items (authenticated users)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { category, search, page = 1, limit = 20 } = req.query;
    const tenantId = req.tenant._id;

    const query = { tenantId, isActive: true };

    if (category) {
      query.category = category;
    }

    if (search) {
      query.$or = [
        { question: { $regex: search, $options: 'i' } },
        { answer: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [items, total] = await Promise.all([
      KBItem.find(query)
        .sort({ priority: -1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      KBItem.countDocuments(query)
    ]);

    // Get categories for filtering
    const categories = await KBItem.distinct('category', { tenantId, isActive: true });

    res.json({
      items,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      categories,
      usage: req.tenant.usage,
      limits: req.tenant.limits
    });

  } catch (error) {
    console.error('Get knowledge base error:', error);
    res.status(500).json({ error: 'Failed to get knowledge base items' });
  }
});

// Create knowledge base item
router.post('/', authenticateToken, requireRole(['owner', 'admin']), checkUsageLimit('knowledgeItems'), [
  body('question').trim().isLength({ min: 1 }),
  body('answer').trim().isLength({ min: 1 }),
  body('category').optional().trim(),
  body('tags').optional().isArray(),
  body('priority').optional().isInt({ min: 0, max: 10 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { question, answer, category, tags, priority } = req.body;
    const tenantId = req.tenant._id;

    const kbItem = new KBItem({
      tenantId,
      question,
      answer,
      category: category || 'general',
      tags: tags || [],
      priority: priority || 0
    });

    // Generate embedding
    try {
      const embedding = await embeddingService.updateKnowledgeEmbedding(kbItem);
      console.log('Generated embedding for knowledge item');
    } catch (embeddingError) {
      console.warn('Failed to generate embedding:', embeddingError.message);
      // Continue without embedding
    }

    await kbItem.save();

    // Update tenant usage
    await req.tenant.incrementUsage('knowledgeItems');

    res.status(201).json({
      message: 'Knowledge base item created successfully',
      item: kbItem
    });

  } catch (error) {
    console.error('Create knowledge base item error:', error);
    res.status(500).json({ error: 'Failed to create knowledge base item' });
  }
});

// Update knowledge base item
router.put('/:itemId', authenticateToken, requireRole(['owner', 'admin']), [
  body('question').optional().trim().isLength({ min: 1 }),
  body('answer').optional().trim().isLength({ min: 1 }),
  body('category').optional().trim(),
  body('tags').optional().isArray(),
  body('priority').optional().isInt({ min: 0, max: 10 }),
  body('isActive').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { itemId } = req.params;
    const { question, answer, category, tags, priority, isActive } = req.body;
    const tenantId = req.tenant._id;

    const kbItem = await KBItem.findOne({ _id: itemId, tenantId });

    if (!kbItem) {
      return res.status(404).json({ error: 'Knowledge base item not found' });
    }

    let needsEmbeddingUpdate = false;

    if (question) {
      kbItem.question = question;
      needsEmbeddingUpdate = true;
    }
    if (answer) {
      kbItem.answer = answer;
      needsEmbeddingUpdate = true;
    }
    if (category) kbItem.category = category;
    if (tags) kbItem.tags = tags;
    if (priority !== undefined) kbItem.priority = priority;
    if (isActive !== undefined) kbItem.isActive = isActive;

    // Update metadata
    kbItem.metadata.lastUpdated = new Date();
    kbItem.metadata.version += 1;

    // Regenerate embedding if content changed
    if (needsEmbeddingUpdate) {
      try {
        await embeddingService.updateKnowledgeEmbedding(kbItem);
      } catch (embeddingError) {
        console.warn('Failed to update embedding:', embeddingError.message);
      }
    }

    await kbItem.save();

    res.json({
      message: 'Knowledge base item updated successfully',
      item: kbItem
    });

  } catch (error) {
    console.error('Update knowledge base item error:', error);
    res.status(500).json({ error: 'Failed to update knowledge base item' });
  }
});

// Delete knowledge base item
router.delete('/:itemId', authenticateToken, requireRole(['owner', 'admin']), async (req, res) => {
  try {
    const { itemId } = req.params;
    const tenantId = req.tenant._id;

    const result = await KBItem.deleteOne({ _id: itemId, tenantId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Knowledge base item not found' });
    }

    // Update tenant usage
    await req.tenant.incrementUsage('knowledgeItems', -1);

    res.json({ message: 'Knowledge base item deleted successfully' });

  } catch (error) {
    console.error('Delete knowledge base item error:', error);
    res.status(500).json({ error: 'Failed to delete knowledge base item' });
  }
});

// Search knowledge base (API endpoint)
router.post('/search', authenticateApiKey, requirePermission('kb:read'), [
  body('query').trim().isLength({ min: 1 }),
  body('limit').optional().isInt({ min: 1, max: 20 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { query, limit = 5 } = req.body;
    const tenantId = req.tenant._id;

    // Find similar knowledge items
    const similarItems = await embeddingService.findSimilarKnowledge(
      tenantId,
      query,
      limit
    );

    res.json({
      query,
      results: similarItems.map(scored => ({
        item: {
          id: scored.item._id,
          question: scored.item.question,
          answer: scored.item.answer,
          category: scored.item.category,
          tags: scored.item.tags
        },
        similarity: scored.similarity
      })),
      count: similarItems.length
    });

  } catch (error) {
    console.error('Search knowledge base error:', error);
    res.status(500).json({ error: 'Failed to search knowledge base' });
  }
});

// Bulk import knowledge base items
router.post('/import', authenticateToken, requireRole(['owner', 'admin']), [
  body('items').isArray({ min: 1 }),
  body('items.*.question').trim().isLength({ min: 1 }),
  body('items.*.answer').trim().isLength({ min: 1 }),
  body('items.*.category').optional().trim(),
  body('items.*.tags').optional().isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { items } = req.body;
    const tenantId = req.tenant._id;

    // Check if import would exceed limits
    const currentCount = req.tenant.usage.knowledgeItems;
    const limit = req.tenant.limits.knowledgeItems;

    if (currentCount + items.length > limit) {
      return res.status(403).json({
        error: 'Import would exceed knowledge base limit',
        current: currentCount,
        importing: items.length,
        limit
      });
    }

    const createdItems = [];
    const importErrors = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const itemData = items[i];
        const kbItem = new KBItem({
          tenantId,
          question: itemData.question,
          answer: itemData.answer,
          category: itemData.category || 'general',
          tags: itemData.tags || [],
          priority: itemData.priority || 0
        });

        // Generate embedding
        try {
          await embeddingService.updateKnowledgeEmbedding(kbItem);
        } catch (embeddingError) {
          console.warn(`Failed to generate embedding for item ${i}:`, embeddingError.message);
        }

        await kbItem.save();
        createdItems.push(kbItem);

      } catch (itemError) {
        importErrors.push({
          index: i,
          error: itemError.message,
          item: items[i]
        });
      }
    }

    // Update tenant usage
    if (createdItems.length > 0) {
      await req.tenant.incrementUsage('knowledgeItems', createdItems.length);
    }

    res.status(201).json({
      message: 'Knowledge base import completed',
      imported: createdItems.length,
      errors: importErrors.length,
      items: createdItems,
      importErrors: importErrors
    });

  } catch (error) {
    console.error('Import knowledge base error:', error);
    res.status(500).json({ error: 'Failed to import knowledge base items' });
  }
});

export default router;

import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import ApiKey from '../models/ApiKey.js';

const router = express.Router();

// Get all API keys for tenant
router.get('/', authenticateToken, async (req, res) => {
  try {
    const tenantId = req.tenant._id;

    const apiKeys = await ApiKey.find({ tenantId })
      .sort({ createdAt: -1 });

    res.json({
      apiKeys: apiKeys.map(key => {
        const raw = key.key || '';
        const masked = raw && raw.length > 8
          ? `${raw.substring(0, 12)}...${raw.slice(-4)}`
          : '********';
        return {
          id: key._id,
          name: key.name,
          permissions: key.permissions,
          isActive: key.isActive,
          lastUsed: key.lastUsed,
          usageCount: key.usageCount,
          createdAt: key.createdAt,
          expiresAt: key.expiresAt,
          maskedKey: masked
        };
      })
    });

  } catch (error) {
    console.error('Get API keys error:', error);
    res.status(500).json({ error: 'Failed to get API keys' });
  }
});

// Create new API key
router.post('/', authenticateToken, requireRole(['owner', 'admin']), [
  body('name').trim().isLength({ min: 1 }),
  body('permissions').optional().isArray(),
  body('expiresIn').optional().isInt({ min: 1 }),
  body('allowedOrigins').optional().isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { name, permissions, expiresIn, allowedOrigins } = req.body;
    const tenantId = req.tenant._id;

    // Set expiration date if specified
    let expiresAt = null;
    if (expiresIn) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresIn);
    }

    const apiKey = new ApiKey({
      tenantId,
      name,
      permissions: permissions || ['chat:read', 'chat:write'],
      allowedOrigins: allowedOrigins || [],
      expiresAt
    });

    await apiKey.save();

    res.status(201).json({
      message: 'API key created successfully',
      apiKey: {
        id: apiKey._id,
        name: apiKey.name,
        key: apiKey.key, // Only return the key on creation
        permissions: apiKey.permissions,
        expiresAt: apiKey.expiresAt,
        allowedOrigins: apiKey.allowedOrigins
      }
    });

  } catch (error) {
    console.error('Create API key error:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Update API key
router.put('/:keyId', authenticateToken, requireRole(['owner', 'admin']), [
  body('name').optional().trim().isLength({ min: 1 }),
  body('permissions').optional().isArray(),
  body('isActive').optional().isBoolean(),
  body('allowedOrigins').optional().isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { keyId } = req.params;
    const { name, permissions, isActive, allowedOrigins } = req.body;
    const tenantId = req.tenant._id;

    const apiKey = await ApiKey.findOne({ _id: keyId, tenantId });

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    if (name) apiKey.name = name;
    if (permissions) apiKey.permissions = permissions;
    if (isActive !== undefined) apiKey.isActive = isActive;
    if (allowedOrigins) apiKey.allowedOrigins = allowedOrigins;

    await apiKey.save();

    res.json({
      message: 'API key updated successfully',
      apiKey: {
        id: apiKey._id,
        name: apiKey.name,
        permissions: apiKey.permissions,
        isActive: apiKey.isActive,
        allowedOrigins: apiKey.allowedOrigins
      }
    });

  } catch (error) {
    console.error('Update API key error:', error);
    res.status(500).json({ error: 'Failed to update API key' });
  }
});

// Delete API key
router.delete('/:keyId', authenticateToken, requireRole(['owner', 'admin']), async (req, res) => {
  try {
    const { keyId } = req.params;
    const tenantId = req.tenant._id;

    const result = await ApiKey.deleteOne({ _id: keyId, tenantId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ message: 'API key deleted successfully' });

  } catch (error) {
    console.error('Delete API key error:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Get API key usage statistics
router.get('/:keyId/usage', authenticateToken, async (req, res) => {
  try {
    const { keyId } = req.params;
    const { days = 30 } = req.query;
    const tenantId = req.tenant._id;

    const apiKey = await ApiKey.findOne({ _id: keyId, tenantId });

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // In a production system, you'd track detailed usage metrics
    // For now, return basic information
    res.json({
      apiKey: {
        id: apiKey._id,
        name: apiKey.name,
        usageCount: apiKey.usageCount,
        lastUsed: apiKey.lastUsed,
        createdAt: apiKey.createdAt
      },
      usage: {
        totalRequests: apiKey.usageCount,
        period: `${days} days`,
        avgRequestsPerDay: Math.round(apiKey.usageCount / days)
      }
    });

  } catch (error) {
    console.error('Get API key usage error:', error);
    res.status(500).json({ error: 'Failed to get API key usage' });
  }
});

export default router;

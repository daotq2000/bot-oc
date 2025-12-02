import express from 'express';
import { PositionController } from '../controllers/PositionController.js';

const router = express.Router();

router.get('/', PositionController.getAll);
router.get('/:id', PositionController.getById);
router.post('/:id/close', PositionController.close);

export default router;


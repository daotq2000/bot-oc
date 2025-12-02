import express from 'express';
import { StrategyController } from '../controllers/StrategyController.js';

const router = express.Router();

router.get('/', StrategyController.getAll);
router.get('/:id', StrategyController.getById);
router.post('/', StrategyController.create);
router.put('/:id', StrategyController.update);
router.delete('/:id', StrategyController.delete);

export default router;


import express from 'express';
import { BotController } from '../controllers/BotController.js';

const router = express.Router();

router.get('/', BotController.getAll);
router.get('/:id', BotController.getById);
router.post('/', BotController.create);
router.put('/:id', BotController.update);
router.delete('/:id', BotController.delete);

export default router;


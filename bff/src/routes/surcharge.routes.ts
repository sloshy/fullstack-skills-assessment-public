import { Router } from 'express';
import * as controller from '../controllers/surcharge.controller';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();

router.post('/quote', asyncHandler(controller.quoteSurcharge));

export default router;

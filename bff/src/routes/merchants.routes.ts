import { Router } from 'express';
import * as controller from '../controllers/merchants.controller';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();

router.get('/me', asyncHandler(controller.fetchMerchant));

export default router;

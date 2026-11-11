import { Router } from 'express';
import * as controller from '../controllers/payments.controller';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();

router.get('/', asyncHandler(controller.fetchPayments));

router.post('/', asyncHandler(controller.createPayment));

router.get('/:id', asyncHandler(controller.fetchPayment));

router.post('/:id/refund', asyncHandler(controller.refundPayment));

export default router;

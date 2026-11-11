import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { getMerchant } from '../services/merchantService';

export async function fetchMerchant(req: AuthenticatedRequest, res: Response): Promise<void> {
  const merchant = await getMerchant(req);
  res.json(merchant);
}

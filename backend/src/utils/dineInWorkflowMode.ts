import type mongoose from 'mongoose';
import { getModels } from '../getModels';
import { parseServiceChargePercent } from './dineInServiceCharge';

export type DineInWorkflowMode = 'pay_first' | 'pay_after';

export type DineInStoreSettings = {
  mode: DineInWorkflowMode;
  serviceChargePercent: number;
  serviceChargeWaived: boolean;
};

/**
 * 店铺堂食流程模式。缺省或未识别时与历史数据一致：pay_first。
 */
export async function getDineInStoreSettings(storeId: mongoose.Types.ObjectId): Promise<DineInStoreSettings> {
  const { Store } = getModels();
  const row = (await Store.findById(storeId).select('dineInWorkflowMode dineInServiceChargePercent dineInServiceChargeWaived').lean()) as {
    dineInWorkflowMode?: string;
    dineInServiceChargePercent?: number;
    dineInServiceChargeWaived?: boolean;
  } | null;
  return {
    mode: row?.dineInWorkflowMode === 'pay_after' ? 'pay_after' : 'pay_first',
    serviceChargePercent: parseServiceChargePercent(row?.dineInServiceChargePercent),
    serviceChargeWaived: row?.dineInServiceChargeWaived === true,
  };
}

export async function getDineInWorkflowModeForStore(storeId: mongoose.Types.ObjectId): Promise<DineInWorkflowMode> {
  return (await getDineInStoreSettings(storeId)).mode;
}

export async function getDineInServiceChargePercentForStore(storeId: mongoose.Types.ObjectId): Promise<number> {
  return (await getDineInStoreSettings(storeId)).serviceChargePercent;
}

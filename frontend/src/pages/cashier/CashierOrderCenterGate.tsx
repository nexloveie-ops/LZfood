import UnifiedOrderCenter from './UnifiedOrderCenter';
import PayAfterOrderCenter from './PayAfterOrderCenter';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';

/** 先付店沿用现订单中心；跑单店用桌台工作台。 */
export default function CashierOrderCenterGate() {
  const { config, configLoading } = useRestaurantConfig();
  if (configLoading) {
    return <div style={{ padding: 24, color: 'var(--text-secondary)' }}>…</div>;
  }
  if (config.dine_in_workflow_mode === 'pay_after') {
    return <PayAfterOrderCenter />;
  }
  return <UnifiedOrderCenter />;
}

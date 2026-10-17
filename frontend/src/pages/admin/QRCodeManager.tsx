import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useStoreSlug } from '../../context/StoreContext';
import QRCode from 'qrcode';
import { apiFetch } from '../../api/client';
import { encodeQRParams } from '../../utils/qrCode';

interface QRItem { label: string; url: string; dataUrl: string; }

export default function QRCodeManager() {
  const { t } = useTranslation();
  const { token, hasFeature } = useAuth();
  const canDelivery = hasFeature('cashier.delivery.page');
  const storeSlug = useStoreSlug();
  const [tables, setTables] = useState(5);
  const [seatsPerTable, setSeatsPerTable] = useState(4);
  const [qrItems, setQrItems] = useState<QRItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  // Load saved config on mount
  useEffect(() => {
    apiFetch('/api/admin/config').then(r => r.ok ? r.json() : {}).then((cfg: Record<string, string>) => {
      if (cfg.qr_tables) setTables(parseInt(cfg.qr_tables, 10) || 5);
      if (cfg.qr_seats_per_table != null && cfg.qr_seats_per_table !== '') {
        const seats = parseInt(cfg.qr_seats_per_table, 10);
        if (Number.isFinite(seats) && seats >= 0) setSeatsPerTable(seats);
      }
      setConfigLoaded(true);
    }).catch(() => setConfigLoaded(true));
  }, []);

  const generate = useCallback(async () => {
    setGenerating(true);
    const items: QRItem[] = [];

    for (let table = 1; table <= tables; table++) {
      if (seatsPerTable < 1) {
        const url = `${baseUrl}/${storeSlug}/customer?${encodeQRParams(table)}`;
        const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1 });
        items.push({ label: `Table ${table}`, url, dataUrl });
        continue;
      }
      for (let seat = 1; seat <= seatsPerTable; seat++) {
        const url = `${baseUrl}/${storeSlug}/customer?${encodeQRParams(table, seat)}`;
        const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1 });
        items.push({ label: `Table ${table} · Seat ${seat}`, url, dataUrl });
      }
    }

    const takeoutUrl = `${baseUrl}/${storeSlug}/customer?type=takeout`;
    const takeoutDataUrl = await QRCode.toDataURL(takeoutUrl, { width: 200, margin: 1 });
    items.push({ label: 'Take Away', url: takeoutUrl, dataUrl: takeoutDataUrl });

    if (canDelivery) {
      const deliveryUrl = `${baseUrl}/${storeSlug}/customer?type=delivery`;
      const deliveryDataUrl = await QRCode.toDataURL(deliveryUrl, { width: 200, margin: 1 });
      items.push({ label: 'Delivery', url: deliveryUrl, dataUrl: deliveryDataUrl });
    }

    setQrItems(items);
    setGenerating(false);

    // Save config to backend
    apiFetch('/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ qr_tables: String(tables), qr_seats_per_table: String(seatsPerTable) }),
    }).catch(() => {});
  }, [tables, seatsPerTable, baseUrl, token, storeSlug, canDelivery]);

  // Auto-generate after config loaded（送餐开关变化时同步 QR 列表）
  useEffect(() => {
    if (configLoaded) void generate();
  }, [configLoaded, generate]);

  const printAll = () => {
    const w = window.open('', '_blank');
    if (!w || !printRef.current) return;
    w.document.write(`<html><head><title>QR Codes</title><style>
      body { font-family: 'Noto Sans SC', sans-serif; }
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; padding: 20px; }
      .qr-card { text-align: center; border: 1px solid #ddd; padding: 16px; border-radius: 8px; page-break-inside: avoid; }
      .qr-card img { width: 160px; height: 160px; }
      .qr-card .label { font-weight: 600; margin-top: 8px; font-size: 14px; }
      .qr-card .url { font-size: 13px; color: #333; font-weight: 700; letter-spacing: 1px; }
      @media print { .grid { gap: 12px; } }
    </style></head><body><div class="grid">`);
    for (const item of qrItems) {
      w.document.write(`<div class="qr-card"><img src="${item.dataUrl}" /><div class="label">${item.label}</div><div class="url">SCAN TO ORDER</div></div>`);
    }
    w.document.write('</div></body></html>');
    w.document.close();
    setTimeout(() => { w.print(); }, 300);
  };

  const printSingle = (item: QRItem) => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<html><head><title>${item.label}</title><style>
      body { font-family: 'Noto Sans SC', sans-serif; text-align: center; padding: 40px; }
      img { width: 240px; height: 240px; }
      .label { font-weight: 700; font-size: 20px; margin-top: 12px; }
      .url { font-size: 14px; color: #333; margin-top: 8px; font-weight: 700; letter-spacing: 1px; }
    </style></head><body>
      <img src="${item.dataUrl}" /><div class="label">${item.label}</div><div class="url">SCAN TO ORDER</div>
    </body></html>`);
    w.document.close();
    setTimeout(() => { w.print(); }, 300);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>{t('admin.qrCodes', 'QR码管理')}</h2>
        <button className="btn btn-primary" onClick={printAll} disabled={qrItems.length === 0}>
          🖨️ {t('cashier.printReceipt', '打印全部')}
        </button>
      </div>

      {/* Config */}
      <div className="card" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 16, alignItems: 'end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>桌数</label>
          <input className="input" type="number" min={1} value={tables} onChange={e => setTables(Number(e.target.value))} style={{ width: 100 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>每桌座位数</label>
          <input className="input" type="number" min={0} value={seatsPerTable} onChange={e => setSeatsPerTable(Math.max(0, Number(e.target.value) || 0))} style={{ width: 100 }} />
        </div>
        <button className="btn btn-gold" onClick={generate} disabled={generating}>
          {generating ? t('common.loading') : '生成 QR 码'}
        </button>
      </div>
      {canDelivery ? (
        <div className="card" style={{ padding: 12, marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe0b2' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#8d6e63', marginBottom: 4 }}>Delivery 二维码说明</div>
          <div style={{ fontSize: 12, color: '#8d6e63', lineHeight: 1.6 }}>
            客人扫码进入送餐下单流程时，需先填写姓名、电话、地址、邮编，再提交订单。
          </div>
        </div>
      ) : null}

      {/* QR Grid */}
      <div ref={printRef} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
        {qrItems.map((item, idx) => (
          <div key={idx} className="card" style={{ padding: 16, textAlign: 'center', cursor: 'pointer' }}
            onClick={() => printSingle(item)}>
            <img src={item.dataUrl} alt={item.label} style={{ width: 140, height: 140 }} />
            <div style={{ fontWeight: 600, fontSize: 13, marginTop: 8 }}>{item.label}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, fontWeight: 700, letterSpacing: 1 }}>SCAN TO ORDER</div>
          </div>
        ))}
      </div>
    </div>
  );
}

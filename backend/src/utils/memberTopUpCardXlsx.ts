import ExcelJS from 'exceljs';

export type TopUpCardXlsxRow = {
  batch: string;
  createdAt: Date | string;
  cardCode: string;
  pin: string;
  amountEuro: string;
  status: string;
  usedAt?: string;
  usedBy?: string;
};

export async function topUpCardsToXlsxBuffer(rows: TopUpCardXlsxRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('topup-cards');
  ws.columns = [
    { header: '批次', key: 'batch', width: 18 },
    { header: '生成时间', key: 'createdAt', width: 22 },
    { header: '卡号', key: 'cardCode', width: 12 },
    { header: 'PIN', key: 'pin', width: 10 },
    { header: '面额(€)', key: 'amountEuro', width: 10 },
    { header: '状态', key: 'status', width: 12 },
    { header: '核销时间', key: 'usedAt', width: 22 },
    { header: '核销会员', key: 'usedBy', width: 14 },
  ];
  for (const r of rows) {
    ws.addRow({
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    });
  }
  ws.getRow(1).font = { bold: true };
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

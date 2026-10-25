import { buildFeieyunReceiptContent, type CloudPrintReceipt } from './buildFeieyunReceipt';

function sampleReceipt(over: Partial<CloudPrintReceipt> = {}): CloudPrintReceipt {
  return {
    checkoutId: 'abc123456789',
    ticketKind: 'placement',
    tableNumber: 2,
    totalAmount: 13,
    paymentMethod: 'pending',
    checkedOutAt: '2026-10-16T16:00:00.000Z',
    restaurant: { name: 'Taste of Asia' },
    orders: [{
      type: 'dine_in',
      dineInOrderNumber: '174501',
      items: [{
        quantity: 1,
        unitPrice: 12,
        itemName: '金牌钟水饺',
        itemNameEn: 'Gold dumpling',
        selectedOptions: [{
          groupName: '辣度',
          choiceName: '加辣',
          choiceNameEn: 'Extra spicy',
          extraPrice: 1,
        }],
      }],
    }],
    ...over,
  };
}

describe('buildFeieyunReceiptContent pay_after kitchen', () => {
  it('hides Kitchen banner and dine-in order number, puts English beside the amount', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({ dineInWorkflowMode: 'pay_after' }));
    expect(html).not.toContain('Kitchen / 厨房');
    expect(html).not.toContain('Order #174501');
    expect(html).not.toContain('Ref:');
    expect(html).toContain('Table 2');
    expect(html).toContain('<B>1X 金牌钟水饺</B>');
    expect(html).toMatch(/Gold dumpling\s+12\.00 EUR/);
    expect(html).not.toMatch(/<L><BOLD>Gold dumpling/);
    expect(html).toContain('<B>  · 加辣 +1.00 EUR</B>');
    expect(html).toContain('    Extra spicy');
    expect(html).not.toContain('<L><B>  · 加辣 Extra spicy +1.00 EUR</B></L>');
    expect(html).not.toContain('◆');
    expect(html).not.toContain('其他 / Other');
    expect(html).not.toContain('<RIGHT>12.00 EUR</RIGHT>');
  });

  it('prints bilingual line notes on the kitchen ticket', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({
      dineInWorkflowMode: 'pay_after',
      orders: [{
        type: 'dine_in',
        items: [{
          quantity: 1,
          unitPrice: 12,
          itemName: '金牌钟水饺',
          itemNameEn: 'Gold dumpling',
          noteZh: '少辣',
          noteEn: 'Less spicy',
        }],
      }],
    }));
    expect(html).toContain('备注 少辣');
    expect(html).toContain('Less spicy');
  });

  it('keeps Kitchen banner and order number for pay_first kitchen tickets', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({ dineInWorkflowMode: 'pay_first' }));
    expect(html).toContain('Kitchen / 厨房');
    expect(html).toContain('Order #174501');
    expect(html).toContain('<B>  · 加辣 +1.00 EUR</B>');
    expect(html).toContain('    Extra spicy');
    expect(html).toMatch(/Gold dumpling\s+12\.00 EUR/);
  });

  it('merges a whole table onto one kitchen ticket without order numbers', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({
      dineInWorkflowMode: 'pay_after',
      wholeTableKitchenTicket: true,
      totalAmount: 40,
      orders: [
        {
          type: 'dine_in',
          dineInOrderNumber: '174501',
          items: [{
            quantity: 1,
            unitPrice: 12,
            itemName: '金牌钟水饺',
            roundIndex: 1,
            selectedOptions: [],
          }],
        },
        {
          type: 'dine_in',
          dineInOrderNumber: '174802',
          items: [{
            quantity: 1,
            unitPrice: 28,
            itemName: '龙虾',
            roundIndex: 1,
            selectedOptions: [],
          }],
        },
      ],
    }));
    expect(html).toContain('Table 2');
    expect(html).toContain('整桌 / Whole table');
    expect(html).toContain('金牌钟水饺');
    expect(html).toContain('龙虾');
    expect(html).not.toContain('Kitchen / 厨房');
    expect(html).not.toContain('Order #174501');
    expect(html).not.toContain('Order #174802');
    expect((html.match(/<CB>Table 2<\/CB>/g) || []).length).toBe(1);
  });

  it('prints 1X name without a [1] round tag on every line', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({
      dineInWorkflowMode: 'pay_after',
      orders: [{
        type: 'dine_in',
        dineInOrderNumber: '174501',
        items: [{
          quantity: 1,
          unitPrice: 12,
          itemName: '金牌钟水饺',
          roundIndex: 1,
          selectedOptions: [],
        }],
      }],
    }));
    expect(html).toContain('1X 金牌钟水饺');
    expect(html).not.toContain('[1]');
    expect(html).not.toContain('Round 1');
  });

  it('prints round headers only when a pay-after kitchen ticket has multiple rounds', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({
      dineInWorkflowMode: 'pay_after',
      orders: [{
        type: 'dine_in',
        items: [
          { quantity: 1, unitPrice: 12, itemName: '水饺', roundIndex: 1, selectedOptions: [] },
          { quantity: 2, unitPrice: 8, itemName: '炒饭', roundIndex: 2, selectedOptions: [] },
        ],
      }],
    }));
    expect(html).toContain('Round 1 / 第1轮');
    expect(html).toContain('Round 2 / 第2轮');
    expect(html).toContain('1X 水饺');
    expect(html).toContain('2X 炒饭');
    expect(html).not.toContain('[1]');
    expect(html).not.toContain('[2]');
  });

  it('omits dish category headers and enlarges option lines', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({
      dineInWorkflowMode: 'pay_after',
      orders: [{
        type: 'dine_in',
        items: [{
          quantity: 1,
          unitPrice: 12,
          itemName: '春卷',
          itemNameEn: 'Spring roll',
          categoryId: 'starters',
          categoryName: '前菜',
          categoryNameEn: 'Starters',
          selectedOptions: [{
            groupName: '酱',
            choiceName: '甜酸酱',
            choiceNameEn: 'Sweet chilli',
          }],
        }],
      }],
    }));
    expect(html).not.toContain('◆');
    expect(html).not.toContain('前菜');
    expect(html).not.toContain('Starters');
    expect(html).toContain('<B>  · 甜酸酱</B>');
    expect(html).toContain('    Sweet chilli');
  });

  it('does not change checkout tickets', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({
      ticketKind: 'checkout',
      dineInWorkflowMode: 'pay_after',
      paymentMethod: 'cash',
    }));
    expect(html).not.toContain('Kitchen / 厨房');
    expect(html).not.toContain('一起上 / Together');
    expect(html).not.toContain('分道上 / Courses');
    expect(html).toContain('Order #174501');
    expect(html).toContain('<B>  · 加辣 +1.00 EUR</B>');
    expect(html).toContain('    Extra spicy');
    expect(html).toMatch(/Gold dumpling\s+12\.00 EUR/);
    expect(html).not.toMatch(/<L><BOLD>Gold dumpling/);
  });

  it('prints waived service as its own line, not a discount', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({
      ticketKind: 'checkout',
      dineInWorkflowMode: 'pay_after',
      paymentMethod: 'cash',
      totalAmount: 13,
      serviceChargePercent: 10,
      serviceChargeAmount: 1.3,
      serviceChargeWaived: true,
    }));
    expect(html).toContain('Service 10% (waived) / 服务费 10%（已减免）');
    expect(html).not.toContain('Discount');
    expect(html).toContain('Subtotal');
  });

  it('prints 一起上 on kitchen tickets by default', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({ dineInWorkflowMode: 'pay_after' }));
    expect(html).toContain('<CB>一起上 / Together</CB>');
  });

  it('prints 分道上 on kitchen tickets when the order is courses', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({
      dineInWorkflowMode: 'pay_after',
      orders: [{
        type: 'dine_in',
        dineInServeStyle: 'courses',
        items: [{
          quantity: 1,
          unitPrice: 12,
          itemName: '金牌钟水饺',
          selectedOptions: [],
        }],
      }],
    }));
    expect(html).toContain('<CB>分道上 / Courses</CB>');
    expect(html).not.toContain('一起上 / Together');
  });

  it('prints mixed serve styles on a whole-table kitchen ticket', () => {
    const html = buildFeieyunReceiptContent(sampleReceipt({
      dineInWorkflowMode: 'pay_after',
      wholeTableKitchenTicket: true,
      orders: [
        {
          type: 'dine_in',
          dineInServeStyle: 'together',
          items: [{ quantity: 1, unitPrice: 12, itemName: '金牌钟水饺', selectedOptions: [] }],
        },
        {
          type: 'dine_in',
          dineInServeStyle: 'courses',
          items: [{ quantity: 1, unitPrice: 28, itemName: '龙虾', selectedOptions: [] }],
        },
      ],
    }));
    expect(html).toContain('<CB>一起上 + 分道上 / Together + Courses</CB>');
  });
});

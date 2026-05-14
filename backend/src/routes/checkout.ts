import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { optionalAuthMiddleware } from '../middleware/auth';
import { hasPermission } from '../middleware/permissions';
import { storeIoRoom } from '../socketRooms';
import {
  computeOrderPayableTotalEuro,
  computeDineInUnsettledPayableEuro,
  computePartialDineInSettlementPreview,
  dineInHasUnsettledFoodLineQty,
} from '../utils/orderPayableTotal';
import { getDineInWorkflowModeForStore } from '../utils/dineInWorkflowMode';
import { resolveMemberPaymentForCheckout } from '../utils/checkoutMemberResolve';
import { creditMemberWallet, debitMemberWallet } from '../utils/memberWalletOps';
import { computeRefundChannelBreakdown } from '../utils/memberRefundAlign';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../utils/featureCatalog';
import {
  markDineInFoodLinesFullySettled,
  markDineInKitchenPrintedQtyFull,
} from '../utils/dineInMarkLinesFullySettled';

function staffMayDebitMemberWithoutPin(req: Request): boolean {
  const u = req.user;
  if (!u) return false;
  return hasPermission(u.role, 'checkout:process');
}

function round2Euro(n: number): number {
  return Math.round(n * 100) / 100;
}

async function finalizeSeatOrderCheckedOut(
  Order: mongoose.Model<any>,
  storeId: mongoose.Types.ObjectId,
  orderId: string,
  patch: { memberId?: mongoose.Types.ObjectId; memberPhoneSnapshot?: string; memberCreditUsed?: number },
): Promise<void> {
  const doc = await Order.findOne({ _id: orderId, storeId });
  if (!doc) {
    throw createAppError('NOT_FOUND', 'Order not found');
  }
  /** 先结/后结统一：整单 finalize 时写满 settledQty，避免后结模式下「checked_out 却仍算出未结」 */
  if (markDineInFoodLinesFullySettled(doc)) {
    doc.markModified('items');
  }
  /** 财务已结清时同步厨房已打满份数，避免先结单 kitchenPrintedQty 全 0，切后结后订单中心仍按「待出厨房」占位 */
  if (doc.type === 'dine_in') {
    const rem = computeDineInUnsettledPayableEuro(doc);
    if (rem <= 0.02 && !dineInHasUnsettledFoodLineQty(doc)) {
      if (markDineInKitchenPrintedQtyFull(doc)) {
        doc.markModified('items');
      }
    }
  }
  doc.status = 'checked_out';
  if (patch.memberId) {
    doc.memberId = patch.memberId;
    doc.memberPhoneSnapshot = patch.memberPhoneSnapshot ?? '';
    doc.memberCreditUsed = patch.memberCreditUsed ?? 0;
  }
  await doc.save();
}

/** 重印小票 / 搜索：不展示 status 含 hide 的订单（与营业报表一致） */
function statusContainsHide(status: unknown): boolean {
  return String(status ?? '').toLowerCase().includes('hide');
}

/** 任一侧订单为 hide 则整笔结账不展示（避免一单多订单时仍出现 hide 金额） */
function checkoutTouchesHiddenOrder(
  c: Record<string, unknown>,
  orderById: Map<string, { status?: unknown }>,
): boolean {
  for (const oid of (c.orderIds || []) as mongoose.Types.ObjectId[]) {
    const o = orderById.get(oid.toString());
    if (o && statusContainsHide(o.status)) return true;
  }
  return false;
}

async function assertMemberWalletFeatureIfNeeded(req: Request): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const pm = String(body.paymentMethod || '');
  const hasMemberPhone = body.memberPhone != null && String(body.memberPhone).trim() !== '';
  if (!hasMemberPhone && pm !== 'member') return;
  const features = await resolveStoreEffectiveFeatures(req.storeId!);
  if (!features.has(FeatureKeys.CashierMemberWallet)) {
    throw createAppError('FORBIDDEN', `当前套餐未开通能力：${FeatureKeys.CashierMemberWallet}`);
  }
}

/** LZFoodModels uses Model<unknown>; narrow for route logic */
function checkoutModels() {
  return getModels() as {
    Order: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
    Member: mongoose.Model<any>;
    MemberWalletTxn: mongoose.Model<any>;
  };
}

export function createCheckoutRouter(io: SocketIOServer): Router {
  const router = Router();

  // POST /api/checkout/table/:tableNumber — Whole table checkout
  router.post('/table/:tableNumber', optionalAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order, Checkout, Member, MemberWalletTxn } = checkoutModels();
      const tableNumber = parseInt(req.params.tableNumber as string, 10);
      if (isNaN(tableNumber)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid table number');
      }

      const { couponName, couponAmount } = req.body;

      // Find all pending dine-in orders for this table
      const orders = await Order.find({ storeId: req.storeId, type: 'dine_in', tableNumber, status: 'pending' });

      if (orders.length === 0) {
        throw createAppError('NOT_FOUND', 'No pending orders found for this table');
      }

      const dineInWf = await getDineInWorkflowModeForStore(req.storeId!);
      let totalAmount: number;
      if (dineInWf === 'pay_after') {
        totalAmount = orders.reduce((sum, order) => sum + computeDineInUnsettledPayableEuro(order), 0);
      } else {
        const itemsTotal = orders.reduce((sum, order) => {
          return sum + order.items.reduce((itemSum: number, item: { unitPrice: number; quantity: number; selectedOptions?: { extraPrice?: number }[] }) => {
            const optExtra = (item.selectedOptions || []).reduce((s: number, o: { extraPrice?: number }) => s + (o.extraPrice || 0), 0);
            return itemSum + (item.unitPrice + optExtra) * item.quantity;
          }, 0);
        }, 0);
        const tableBundleDiscount = orders.reduce((sum, order) => {
          return sum + ((order as unknown as { appliedBundles?: { discount: number }[] }).appliedBundles || [])
            .reduce((s: number, b: { discount: number }) => s + b.discount, 0);
        }, 0);
        totalAmount = itemsTotal - tableBundleDiscount;
      }

      // Apply coupon discount
      let finalAmount = totalAmount;
      if (couponAmount && couponAmount > 0) {
        finalAmount = Math.max(0, totalAmount - couponAmount);
      }

      await assertMemberWalletFeatureIfNeeded(req);
      const mp = await resolveMemberPaymentForCheckout({
        storeId: req.storeId!,
        Member,
        finalAmount,
        body: req.body as Record<string, unknown>,
        skipMemberPin: staffMayDebitMemberWithoutPin(req),
      });

      const checkoutData: Record<string, unknown> = {
        storeId: req.storeId,
        type: 'table',
        tableNumber,
        totalAmount: finalAmount,
        paymentMethod: mp.paymentMethod,
        orderIds: orders.map(o => o._id),
        memberCreditUsed: mp.memberCreditUsed,
      };
      if (mp.memberId) {
        checkoutData.memberId = mp.memberId;
        checkoutData.memberPhoneSnapshot = mp.memberPhoneSnapshot;
      }
      if (mp.paymentMethod === 'mixed') {
        checkoutData.cashAmount = mp.cashAmount;
        checkoutData.cardAmount = mp.cardAmount;
      } else if (mp.paymentMethod === 'cash') {
        checkoutData.cashAmount = mp.cashAmount;
      } else if (mp.paymentMethod === 'card' || mp.paymentMethod === 'online') {
        checkoutData.cardAmount = mp.cardAmount;
      }
      if (couponName) checkoutData.couponName = couponName;
      if (couponAmount && couponAmount > 0) checkoutData.couponAmount = couponAmount;

      const checkout = await Checkout.create(checkoutData);
      try {
        if (mp.memberCreditUsed > 0 && mp.memberId) {
          await debitMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId,
            amountEuro: mp.memberCreditUsed,
            checkoutId: checkout._id,
            note: '整桌结账储值抵扣',
          });
        }
      } catch (e) {
        await Checkout.deleteOne({ _id: checkout._id });
        throw e;
      }

      try {
        const memberPatch = mp.memberId
          ? {
              memberId: mp.memberId as mongoose.Types.ObjectId,
              memberPhoneSnapshot: mp.memberPhoneSnapshot ?? '',
              memberCreditUsed: 0,
            }
          : {};
        for (const o of orders) {
          await finalizeSeatOrderCheckedOut(Order, req.storeId!, o._id.toString(), memberPatch);
        }
      } catch (e) {
        if (mp.memberCreditUsed > 0 && mp.memberId) {
          await creditMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId,
            amountEuro: mp.memberCreditUsed,
            type: 'reversal',
            checkoutId: checkout._id,
            note: '结账后更新订单失败，冲回储值',
          });
        }
        await Checkout.deleteOne({ _id: checkout._id });
        throw e;
      }

      for (const order of orders) {
        io.to(storeIoRoom(req.storeId!)).emit('order:checked-out', { orderId: order._id.toString(), tableNumber });
      }

      res.status(201).json(checkout);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/checkout/seat/:orderId — Per-seat checkout
  router.post('/seat/:orderId', optionalAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order, Checkout, Member, MemberWalletTxn } = checkoutModels();
      const orderId = req.params.orderId as string;
      if (!mongoose.Types.ObjectId.isValid(orderId)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }

      const { totalAmountOverride, couponName, couponAmount } = req.body;

      const order = await Order.findOne({ _id: orderId, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }

      if (order.status !== 'pending') {
        throw createAppError('VALIDATION_ERROR', 'Only pending orders can be checked out', {
          currentStatus: order.status,
        });
      }

      const dineInWf = await getDineInWorkflowModeForStore(req.storeId!);
      const autoTotal =
        order.type === 'dine_in' && dineInWf === 'pay_after'
          ? computeDineInUnsettledPayableEuro(order)
          : computeOrderPayableTotalEuro(order);
      const totalAmount = (totalAmountOverride != null && typeof totalAmountOverride === 'number' && totalAmountOverride >= 0)
        ? totalAmountOverride
        : autoTotal;

      // Apply coupon discount
      let finalAmount = totalAmount;
      if (couponAmount && couponAmount > 0) {
        finalAmount = Math.max(0, totalAmount - couponAmount);
      }

      await assertMemberWalletFeatureIfNeeded(req);
      const mp = await resolveMemberPaymentForCheckout({
        storeId: req.storeId!,
        Member,
        finalAmount,
        body: req.body as Record<string, unknown>,
        skipMemberPin: staffMayDebitMemberWithoutPin(req),
      });

      /**
       * 顾客扫码（外卖自提或堂食）+ 会员全额：与 Stripe 一致 — 先 paid_online、扣储值，不写 Checkout；
       * 由收银 complete-online-paid 再生成 Checkout 并 completed（堂食/自提待打印小票、厨房出单）。
       * 送餐顾客会员全额仍走下方（与 Stripe 送餐一致：当场 Checkout + checked_out）。
       */
      const isCustomerQrFullMemberPrepay =
        (order.type === 'takeout' || order.type === 'dine_in') &&
        !staffMayDebitMemberWithoutPin(req) &&
        mp.paymentMethod === 'member' &&
        mp.memberCreditUsed > 0.001;

      if (isCustomerQrFullMemberPrepay) {
        const walletNote =
          order.type === 'takeout'
            ? '外卖自提扫码储值支付（待收银收尾）'
            : '堂食扫码储值支付（待收银收尾）';
        try {
          await debitMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId!,
            amountEuro: mp.memberCreditUsed,
            orderId: new mongoose.Types.ObjectId(orderId),
            note: walletNote,
          });
        } catch (e) {
          throw e;
        }
        const prePaySet: Record<string, unknown> = {
          status: 'paid_online',
          memberId: mp.memberId,
          memberPhoneSnapshot: mp.memberPhoneSnapshot,
          memberCreditUsed: mp.memberCreditUsed,
        };
        if (order.type === 'dine_in' && dineInWf === 'pay_after') {
          prePaySet.dineInExposedToStaff = true;
        }
        try {
          await Order.findOneAndUpdate({ _id: orderId, storeId: req.storeId }, { $set: prePaySet });
          if (order.type === 'dine_in' && dineInWf === 'pay_after') {
            const doc2 = await Order.findOne({ _id: orderId, storeId: req.storeId });
            if (doc2) {
              for (const line of doc2.items as { lineKind?: string; refunded?: boolean; quantity: number; settledQty?: number }[]) {
                if (line.lineKind === 'delivery_fee') continue;
                if (line.refunded) continue;
                line.settledQty = line.quantity;
              }
              doc2.markModified('items');
              await doc2.save();
            }
          }
        } catch (e) {
          await creditMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId!,
            amountEuro: mp.memberCreditUsed,
            type: 'reversal',
            orderId: new mongoose.Types.ObjectId(orderId),
            note: '更新订单失败，冲回储值',
          });
          throw e;
        }
        const updatedLean = await Order.findOne({ _id: orderId, storeId: req.storeId }).lean();
        io.to(storeIoRoom(req.storeId!)).emit('order:updated', updatedLean);
        res.status(201).json({
          ok: true,
          status: 'paid_online',
          orderId,
          memberPrepaidTakeout: order.type === 'takeout',
          memberPrepaidDineIn: order.type === 'dine_in',
        });
        return;
      }

      const checkoutData: Record<string, unknown> = {
        storeId: req.storeId,
        type: 'seat',
        totalAmount: finalAmount,
        paymentMethod: mp.paymentMethod,
        orderIds: [order._id],
        memberCreditUsed: mp.memberCreditUsed,
      };

      if (order.tableNumber != null) {
        checkoutData.tableNumber = order.tableNumber;
      }

      if (mp.memberId) {
        checkoutData.memberId = mp.memberId;
        checkoutData.memberPhoneSnapshot = mp.memberPhoneSnapshot;
      }
      if (mp.paymentMethod === 'mixed') {
        checkoutData.cashAmount = mp.cashAmount;
        checkoutData.cardAmount = mp.cardAmount;
      } else if (mp.paymentMethod === 'cash') {
        checkoutData.cashAmount = mp.cashAmount;
      } else if (mp.paymentMethod === 'card' || mp.paymentMethod === 'online') {
        checkoutData.cardAmount = mp.cardAmount;
      }
      if (couponName) checkoutData.couponName = couponName;
      if (couponAmount && couponAmount > 0) checkoutData.couponAmount = couponAmount;

      const checkout = await Checkout.create(checkoutData);
      try {
        if (mp.memberCreditUsed > 0 && mp.memberId) {
          await debitMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId,
            amountEuro: mp.memberCreditUsed,
            orderId: new mongoose.Types.ObjectId(orderId),
            checkoutId: checkout._id,
            note: '单笔结账储值抵扣',
          });
        }
      } catch (e) {
        await Checkout.deleteOne({ _id: checkout._id });
        throw e;
      }

      /** 与 Stripe 在线支付一致：QR 送餐预付款记为 checked_out，便于顾客端显示「已支付」与配送流程 */
      try {
        await finalizeSeatOrderCheckedOut(
          Order,
          req.storeId!,
          orderId,
          mp.memberId
            ? {
                memberId: mp.memberId as mongoose.Types.ObjectId,
                memberPhoneSnapshot: mp.memberPhoneSnapshot ?? '',
                memberCreditUsed: mp.memberCreditUsed ?? 0,
              }
            : {},
        );
      } catch (e) {
        if (mp.memberCreditUsed > 0 && mp.memberId) {
          await creditMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId,
            amountEuro: mp.memberCreditUsed,
            type: 'reversal',
            orderId: new mongoose.Types.ObjectId(orderId),
            checkoutId: checkout._id,
            note: '更新订单失败，冲回储值',
          });
        }
        await Checkout.deleteOne({ _id: checkout._id });
        throw e;
      }

      io.to(storeIoRoom(req.storeId!)).emit('order:checked-out', { orderId: order._id.toString(), tableNumber: order.tableNumber });

      res.status(201).json(checkout);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/checkout/dine-in-partial/:orderId — 后结堂食：按行结清部分份数（Bundle 按比例摊到本次子集）
  router.post('/dine-in-partial/:orderId', optionalAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order, Checkout, Member, MemberWalletTxn } = checkoutModels();
      const orderId = req.params.orderId as string;
      if (!mongoose.Types.ObjectId.isValid(orderId)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }
      const wf = await getDineInWorkflowModeForStore(req.storeId!);
      if (wf !== 'pay_after') {
        throw createAppError('VALIDATION_ERROR', '仅后结堂食支持按行部分结账');
      }
      const order = await Order.findOne({ _id: orderId, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }
      if (order.type !== 'dine_in' || !['pending', 'paid_online', 'checked_out'].includes(String(order.status))) {
        throw createAppError('VALIDATION_ERROR', '仅支持待结账或仍有未结金额的堂食订单', { currentStatus: order.status, type: order.type });
      }
      const raw = (req.body as Record<string, unknown>).lineSettlements;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw createAppError('VALIDATION_ERROR', 'lineSettlements 必须为非空数组');
      }
      const lineSettlements = raw.map((r) => ({
        lineId: String((r as { lineId?: unknown }).lineId ?? '').trim(),
        qty: Number((r as { qty?: unknown }).qty),
      }));
      const preview = computePartialDineInSettlementPreview(order, lineSettlements);
      if (!preview.ok) {
        throw createAppError('VALIDATION_ERROR', preview.message);
      }
      const { couponName, couponAmount } = req.body as Record<string, unknown>;
      let totalAmount = preview.payable;
      if (couponAmount && typeof couponAmount === 'number' && couponAmount > 0) {
        totalAmount = Math.max(0, round2Euro(totalAmount - couponAmount));
      }

      await assertMemberWalletFeatureIfNeeded(req);
      const mp = await resolveMemberPaymentForCheckout({
        storeId: req.storeId!,
        Member,
        finalAmount: totalAmount,
        body: req.body as Record<string, unknown>,
        skipMemberPin: staffMayDebitMemberWithoutPin(req),
      });

      const checkoutData: Record<string, unknown> = {
        storeId: req.storeId,
        type: 'seat',
        totalAmount,
        paymentMethod: mp.paymentMethod,
        orderIds: [order._id],
        memberCreditUsed: mp.memberCreditUsed,
        dineInPartialLineSettlements: preview.lines.map((l) => ({
          orderLineItemId: new mongoose.Types.ObjectId(l.orderLineItemId),
          quantity: l.quantity,
          amountEuro: l.amountEuro,
        })),
      };
      if (order.tableNumber != null) {
        checkoutData.tableNumber = order.tableNumber;
      }
      if (mp.memberId) {
        checkoutData.memberId = mp.memberId;
        checkoutData.memberPhoneSnapshot = mp.memberPhoneSnapshot;
      }
      if (mp.paymentMethod === 'mixed') {
        checkoutData.cashAmount = mp.cashAmount;
        checkoutData.cardAmount = mp.cardAmount;
      } else if (mp.paymentMethod === 'cash') {
        checkoutData.cashAmount = mp.cashAmount;
      } else if (mp.paymentMethod === 'card' || mp.paymentMethod === 'online') {
        checkoutData.cardAmount = mp.cardAmount;
      }
      if (couponName) checkoutData.couponName = couponName;
      if (couponAmount && typeof couponAmount === 'number' && couponAmount > 0) {
        checkoutData.couponAmount = couponAmount;
      }

      const checkout = await Checkout.create(checkoutData);
      try {
        if (mp.memberCreditUsed > 0 && mp.memberId) {
          await debitMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId,
            amountEuro: mp.memberCreditUsed,
            orderId: new mongoose.Types.ObjectId(orderId),
            checkoutId: checkout._id,
            note: '堂食后结部分结账储值抵扣',
          });
        }
      } catch (e) {
        await Checkout.deleteOne({ _id: checkout._id });
        throw e;
      }

      const doc = await Order.findOne({ _id: orderId, storeId: req.storeId });
      if (!doc) {
        if (mp.memberCreditUsed > 0 && mp.memberId) {
          await creditMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId,
            amountEuro: mp.memberCreditUsed,
            type: 'reversal',
            orderId: new mongoose.Types.ObjectId(orderId),
            checkoutId: checkout._id,
            note: '部分结账更新订单失败，冲回储值',
          });
        }
        await Checkout.deleteOne({ _id: checkout._id });
        throw createAppError('NOT_FOUND', 'Order not found');
      }
      for (const row of lineSettlements) {
        const line = doc.items.id(row.lineId);
        if (!line) {
          if (mp.memberCreditUsed > 0 && mp.memberId) {
            await creditMemberWallet({
              Member,
              MemberWalletTxn,
              storeId: req.storeId!,
              memberId: mp.memberId,
              amountEuro: mp.memberCreditUsed,
              type: 'reversal',
              orderId: new mongoose.Types.ObjectId(orderId),
              checkoutId: checkout._id,
              note: '部分结账行缺失，冲回储值',
            });
          }
          await Checkout.deleteOne({ _id: checkout._id });
          throw createAppError('VALIDATION_ERROR', `行不存在: ${row.lineId}`);
        }
        const cur = Number((line as { settledQty?: number }).settledQty) || 0;
        (line as { settledQty?: number }).settledQty = cur + row.qty;
      }
      doc.markModified('items');
      const remaining = computeDineInUnsettledPayableEuro(doc);
      if (remaining <= 0.02 && !dineInHasUnsettledFoodLineQty(doc)) {
        doc.status = 'checked_out';
        markDineInKitchenPrintedQtyFull(doc);
        doc.markModified('items');
      }
      await doc.save();

      if (doc.status === 'checked_out') {
        io.to(storeIoRoom(req.storeId!)).emit('order:checked-out', {
          orderId: doc._id.toString(),
          tableNumber: doc.tableNumber,
        });
      } else {
        io.to(storeIoRoom(req.storeId!)).emit('order:updated', doc);
      }

      res.status(201).json(checkout);
    } catch (err) {
      next(err);
    }
  });

  /**
   * 后结堂食：整桌一次支付，仅结清勾选的行（可跨多笔 pending 单），与单笔 dine-in-partial 规则一致（Bundle 按单分摊）。
   * body.lineSettlements: { orderId: string; lineId: string; qty: number }[]
   */
  router.post('/dine-in-partial-table/:tableNumber', optionalAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order, Checkout, Member, MemberWalletTxn } = checkoutModels();
      const tableNumber = parseInt(req.params.tableNumber as string, 10);
      if (isNaN(tableNumber)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid table number');
      }
      const wf = await getDineInWorkflowModeForStore(req.storeId!);
      if (wf !== 'pay_after') {
        throw createAppError('VALIDATION_ERROR', '仅后结堂食支持按桌勾选部分结账');
      }
      const raw = (req.body as Record<string, unknown>).lineSettlements;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw createAppError('VALIDATION_ERROR', 'lineSettlements 必须为非空数组');
      }
      type Row = { orderId: string; lineId: string; qty: number };
      const mergedByOrder = new Map<string, Map<string, number>>();
      for (const r of raw) {
        const orderId = String((r as { orderId?: unknown }).orderId ?? '').trim();
        const lineId = String((r as { lineId?: unknown }).lineId ?? '').trim();
        const qty = Number((r as { qty?: unknown }).qty);
        if (!mongoose.Types.ObjectId.isValid(orderId) || !mongoose.Types.ObjectId.isValid(lineId) || !(qty >= 1)) {
          throw createAppError('VALIDATION_ERROR', '每项需含有效 orderId、lineId 与 qty≥1');
        }
        if (!mergedByOrder.has(orderId)) mergedByOrder.set(orderId, new Map());
        const m = mergedByOrder.get(orderId)!;
        const prev = m.get(lineId) || 0;
        m.set(lineId, prev + Math.floor(qty));
      }
      const orderIds = [...mergedByOrder.keys()];
      const orders = await Order.find({
        _id: { $in: orderIds.map((id) => new mongoose.Types.ObjectId(id)) },
        storeId: req.storeId,
        type: 'dine_in',
        status: { $in: ['pending', 'paid_online', 'checked_out'] },
        tableNumber,
      });
      if (orders.length !== orderIds.length) {
        throw createAppError('VALIDATION_ERROR', '订单不存在、状态不允许部分结账或桌号不一致');
      }
      let totalPayable = 0;
      const allCheckoutLines: { orderLineItemId: mongoose.Types.ObjectId; quantity: number; amountEuro: number }[] = [];
      const lineSettlementsByOrder = new Map<string, { lineId: string; qty: number }[]>();
      for (const [oid, lineMap] of mergedByOrder) {
        const lineSettlements = [...lineMap.entries()].map(([lineId, qty]) => ({ lineId, qty }));
        lineSettlementsByOrder.set(oid, lineSettlements);
        const order = orders.find((o) => o._id.toString() === oid);
        if (!order) {
          throw createAppError('NOT_FOUND', `Order ${oid}`);
        }
        const preview = computePartialDineInSettlementPreview(order, lineSettlements);
        if (!preview.ok) {
          throw createAppError('VALIDATION_ERROR', preview.message);
        }
        totalPayable += preview.payable;
        for (const l of preview.lines) {
          allCheckoutLines.push({
            orderLineItemId: new mongoose.Types.ObjectId(l.orderLineItemId),
            quantity: l.quantity,
            amountEuro: l.amountEuro,
          });
        }
      }
      totalPayable = round2Euro(totalPayable);
      const { couponName, couponAmount } = req.body as Record<string, unknown>;
      let finalAmount = totalPayable;
      if (couponAmount && typeof couponAmount === 'number' && couponAmount > 0) {
        finalAmount = Math.max(0, round2Euro(totalPayable - couponAmount));
      }

      await assertMemberWalletFeatureIfNeeded(req);
      const mp = await resolveMemberPaymentForCheckout({
        storeId: req.storeId!,
        Member,
        finalAmount,
        body: req.body as Record<string, unknown>,
        skipMemberPin: staffMayDebitMemberWithoutPin(req),
      });

      const checkoutData: Record<string, unknown> = {
        storeId: req.storeId,
        type: 'table',
        tableNumber,
        totalAmount: finalAmount,
        paymentMethod: mp.paymentMethod,
        orderIds: orders.map((o) => o._id),
        memberCreditUsed: mp.memberCreditUsed,
        dineInPartialLineSettlements: allCheckoutLines,
      };
      if (mp.memberId) {
        checkoutData.memberId = mp.memberId;
        checkoutData.memberPhoneSnapshot = mp.memberPhoneSnapshot;
      }
      if (mp.paymentMethod === 'mixed') {
        checkoutData.cashAmount = mp.cashAmount;
        checkoutData.cardAmount = mp.cardAmount;
      } else if (mp.paymentMethod === 'cash') {
        checkoutData.cashAmount = mp.cashAmount;
      } else if (mp.paymentMethod === 'card' || mp.paymentMethod === 'online') {
        checkoutData.cardAmount = mp.cardAmount;
      }
      if (couponName) checkoutData.couponName = couponName;
      if (couponAmount && typeof couponAmount === 'number' && couponAmount > 0) {
        checkoutData.couponAmount = couponAmount;
      }

      const checkout = await Checkout.create(checkoutData);
      try {
        if (mp.memberCreditUsed > 0 && mp.memberId) {
          await debitMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId,
            amountEuro: mp.memberCreditUsed,
            checkoutId: checkout._id,
            note: '堂食后结按桌部分结账储值抵扣',
          });
        }
      } catch (e) {
        await Checkout.deleteOne({ _id: checkout._id });
        throw e;
      }

      const savedIds: mongoose.Types.ObjectId[] = [];
      try {
        for (const order of orders) {
          const oid = order._id.toString();
          const rows = lineSettlementsByOrder.get(oid);
          if (!rows) continue;
          for (const row of rows) {
            const line = order.items.id(row.lineId);
            if (!line) {
              throw createAppError('VALIDATION_ERROR', `行不存在: ${row.lineId}`);
            }
            const cur = Number((line as { settledQty?: number }).settledQty) || 0;
            (line as { settledQty?: number }).settledQty = cur + row.qty;
          }
          const remaining = computeDineInUnsettledPayableEuro(order);
          if (remaining <= 0.02) {
            order.status = 'checked_out';
            if (!dineInHasUnsettledFoodLineQty(order)) {
              markDineInKitchenPrintedQtyFull(order);
            }
          }
          order.markModified('items');
          await order.save();
          savedIds.push(order._id);
        }
      } catch (err) {
        for (const id of savedIds) {
          const doc = await Order.findOne({ _id: id, storeId: req.storeId });
          if (!doc) continue;
          const rows = lineSettlementsByOrder.get(id.toString());
          if (!rows) continue;
          for (const row of rows) {
            const line = doc.items.id(row.lineId);
            if (!line) continue;
            const cur = Number((line as { settledQty?: number }).settledQty) || 0;
            (line as { settledQty?: number }).settledQty = Math.max(0, cur - row.qty);
          }
          doc.markModified('items');
          const remaining = computeDineInUnsettledPayableEuro(doc);
          if (remaining > 0.02 || dineInHasUnsettledFoodLineQty(doc)) doc.status = 'pending';
          await doc.save();
        }
        if (mp.memberCreditUsed > 0 && mp.memberId) {
          await creditMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId,
            amountEuro: mp.memberCreditUsed,
            type: 'reversal',
            checkoutId: checkout._id,
            note: '按桌部分结账失败，冲回储值',
          });
        }
        await Checkout.deleteOne({ _id: checkout._id });
        return next(err);
      }

      for (const order of orders) {
        if (order.status === 'checked_out') {
          io.to(storeIoRoom(req.storeId!)).emit('order:checked-out', {
            orderId: order._id.toString(),
            tableNumber: order.tableNumber,
          });
        } else {
          io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);
        }
      }

      res.status(201).json(checkout);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/checkout/receipt/:checkoutId — Get receipt data
  router.get('/receipt/:checkoutId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order, Checkout } = checkoutModels();
      const { checkoutId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(checkoutId as string)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid checkout ID');
      }

      const checkout = await Checkout.findOne({ _id: checkoutId, storeId: req.storeId }).lean() as {
        _id: mongoose.Types.ObjectId;
        orderIds: mongoose.Types.ObjectId[];
        type: string;
        tableNumber?: number;
        totalAmount: number;
        paymentMethod: string;
        cashAmount?: number;
        cardAmount?: number;
        checkedOutAt?: Date;
        dineInPartialLineSettlements?: { orderLineItemId: mongoose.Types.ObjectId; quantity: number; amountEuro: number }[];
      } | null;
      if (!checkout) {
        throw createAppError('NOT_FOUND', 'Checkout not found');
      }

      // Populate orders with their items
      const orders = await Order.find({ storeId: req.storeId, _id: { $in: checkout.orderIds } }).lean();

      const partial = (checkout.dineInPartialLineSettlements || []).map((r) => ({
        orderLineItemId: r.orderLineItemId.toString(),
        quantity: r.quantity,
        amountEuro: r.amountEuro,
      }));

      res.json({
        checkoutId: checkout._id,
        type: checkout.type,
        tableNumber: checkout.tableNumber,
        totalAmount: checkout.totalAmount,
        paymentMethod: checkout.paymentMethod,
        cashAmount: checkout.cashAmount,
        cardAmount: checkout.cardAmount,
        memberCreditUsed: (checkout as { memberCreditUsed?: number }).memberCreditUsed,
        memberPhoneSnapshot: (checkout as { memberPhoneSnapshot?: string }).memberPhoneSnapshot,
        checkedOutAt: checkout.checkedOutAt,
        ...(partial.length > 0 ? { dineInPartialLineSettlements: partial } : {}),
        orders: orders.map(o => ({
          _id: o._id,
          type: o.type,
          tableNumber: o.tableNumber,
          seatNumber: o.seatNumber,
          dailyOrderNumber: o.dailyOrderNumber,
          dineInOrderNumber: (o as Record<string, unknown>).dineInOrderNumber,
          status: o.status,
          items: o.items,
          customerName: (o as { customerName?: string }).customerName,
          customerPhone: (o as { customerPhone?: string }).customerPhone,
          deliveryAddress: (o as { deliveryAddress?: string }).deliveryAddress,
          postalCode: (o as { postalCode?: string }).postalCode,
          deliveryFeeEuro: (o as { deliveryFeeEuro?: number }).deliveryFeeEuro,
          deliveryDistanceKm: (o as { deliveryDistanceKm?: number }).deliveryDistanceKm,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/checkout/search?orderNumber=123456&date=2026-04-15
  // 无单号：当日 = Checkout.checkedOutAt 落在窗口内的真实小票，外加「从未写入 Checkout」的订单在当日的占位小票
  //（有 completedAt 则按完结日，否则按 createdAt；±14h 与单号搜索一致）。
  // 有单号：按外卖号 dailyOrderNumber / 堂食号 dineInOrderNumber 查找，不按 createdAt 卡日期（避免已付款却搜不到）。
  router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order, Checkout } = checkoutModels();
      const { orderNumber, date } = req.query;

      const rawDate = (date as string) || new Date().toISOString().slice(0, 10);
      const dateStr = String(rawDate).slice(0, 10);
      const parts = dateStr.split('-').map((x) => Number(x));
      const y = parts[0];
      const mo = parts[1];
      const d = parts[2];
      const padMs = 14 * 60 * 60 * 1000; // ±14h：缓和时区与「本地日历日」与 UTC 边界不一致导致的漏单
      const startOfDay =
        Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)
          ? new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0) - padMs)
          : new Date(dateStr + 'T00:00:00.000Z');
      const endOfDay =
        Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)
          ? new Date(Date.UTC(y, mo - 1, d, 23, 59, 59, 999) + padMs)
          : new Date(dateStr + 'T23:59:59.999Z');

      const searchableOrderStatuses = [
        'checked_out',
        'completed',
        'refunded',
        'paid_online',
      ] as const;

      const mapCheckoutToResult = (c: Record<string, unknown>, orderDocs: Record<string, unknown>[]) => {
        const checkoutOrders = orderDocs.filter((o) =>
          (c.orderIds as mongoose.Types.ObjectId[]).some((cid) => cid.toString() === String(o._id)),
        );
        const allItems = checkoutOrders.flatMap((o) => (o.items as unknown[]) || []);
        const allRefunded =
          allItems.length > 0 &&
          allItems.every((i) => !!(i as { refunded?: boolean }).refunded);
        const hasRefund = allItems.some((i) => !!(i as { refunded?: boolean }).refunded);
        return {
          checkoutId: c._id,
          type: c.type,
          tableNumber: c.tableNumber,
          totalAmount: c.totalAmount,
          paymentMethod: c.paymentMethod,
          cashAmount: c.cashAmount,
          cardAmount: c.cardAmount,
          checkedOutAt: c.checkedOutAt,
          refunded: allRefunded,
          partialRefund: hasRefund && !allRefunded,
          orders: checkoutOrders.map((o) => ({
            _id: o._id,
            type: o.type,
            tableNumber: o.tableNumber,
            seatNumber: o.seatNumber,
            dailyOrderNumber: o.dailyOrderNumber,
            dineInOrderNumber: o.dineInOrderNumber,
            status: o.status,
            customerName: o.customerName,
            customerPhone: o.customerPhone,
            deliveryAddress: o.deliveryAddress,
            postalCode: o.postalCode,
            deliveryFeeEuro: o.deliveryFeeEuro,
            deliveryDistanceKm: o.deliveryDistanceKm,
            appliedBundles: (o.appliedBundles as unknown[]) ?? [],
            items: o.items,
          })),
        };
      };

      type PayableOrderInput = Parameters<typeof computeOrderPayableTotalEuro>[0];
      const syntheticReceiptFromOrder = (o: Record<string, unknown>) => {
        const oItems = (o.items as unknown[]) || [];
        const allRefunded =
          oItems.length > 0 && oItems.every((i) => !!(i as { refunded?: boolean }).refunded);
        const hasRefund = oItems.some((i) => !!(i as { refunded?: boolean }).refunded);
        const ts = (o.completedAt || o.updatedAt || o.createdAt) as Date | string | undefined;
        const checkedOutAt = ts ? new Date(ts).toISOString() : new Date().toISOString();
        const orderSlice = {
          _id: o._id,
          type: o.type,
          tableNumber: o.tableNumber,
          seatNumber: o.seatNumber,
          dailyOrderNumber: o.dailyOrderNumber,
          dineInOrderNumber: o.dineInOrderNumber,
          status: o.status,
          customerName: o.customerName,
          customerPhone: o.customerPhone,
          deliveryAddress: o.deliveryAddress,
          postalCode: o.postalCode,
          deliveryFeeEuro: o.deliveryFeeEuro,
          deliveryDistanceKm: o.deliveryDistanceKm,
          appliedBundles: (o.appliedBundles as unknown[]) ?? [],
          items: o.items,
        };
        const stripePiVirt = String((o as { stripePaymentIntentId?: string }).stripePaymentIntentId || '').trim();
        const memberUsedVirt = Number((o as { memberCreditUsed?: number }).memberCreditUsed) || 0;
        const virtPm =
          !stripePiVirt && memberUsedVirt > 0.001 ? 'member' : 'online';
        const phoneVirt = String((o as { memberPhoneSnapshot?: string }).memberPhoneSnapshot || '').trim();
        return {
          checkoutId: `virtual:${String(o._id)}`,
          type: 'seat',
          tableNumber: o.tableNumber,
          totalAmount: computeOrderPayableTotalEuro(o as PayableOrderInput),
          paymentMethod: virtPm,
          ...(virtPm === 'member'
            ? { memberCreditUsed: memberUsedVirt, memberPhoneSnapshot: phoneVirt }
            : {}),
          cashAmount: undefined,
          cardAmount: undefined,
          checkedOutAt,
          refunded: allRefunded,
          partialRefund: hasRefund && !allRefunded,
          orders: [orderSlice],
        };
      };

      let checkouts: Record<string, unknown>[];
      let orders: Record<string, unknown>[];

      const trimmedNum =
        orderNumber && String(orderNumber).trim()
          ? String(orderNumber).trim().replace(/^\#+/, '').trim()
          : '';

      if (trimmedNum) {
        const num = Number(trimmedNum);
        const numberOr: Record<string, unknown>[] = [{ dineInOrderNumber: trimmedNum }];
        if (Number.isFinite(num) && !Number.isNaN(num)) {
          numberOr.push({ dailyOrderNumber: num });
        }
        // 少数库里 dailyOrderNumber 以字符串等形式存储时，补一条原始条件
        numberOr.push({ dailyOrderNumber: trimmedNum });
        const orderFilter: Record<string, unknown> = {
          storeId: req.storeId,
          status: { $in: [...searchableOrderStatuses] },
          $or: numberOr,
        };
        orders = (await Order.find(orderFilter).sort({ createdAt: -1 }).lean()) as Record<string, unknown>[];
        orders = orders.filter((o) => !statusContainsHide(o.status));
        if (orders.length === 0) {
          res.json([]);
          return;
        }
        const orderIds = orders.map((o) => o._id);
        checkouts = (await Checkout.find({ storeId: req.storeId, orderIds: { $in: orderIds } })
          .sort({ checkedOutAt: -1 })
          .lean()) as Record<string, unknown>[];
        const allCoIds = new Set<string>();
        for (const c of checkouts) {
          for (const cid of (c.orderIds || []) as mongoose.Types.ObjectId[]) {
            allCoIds.add(cid.toString());
          }
        }
        const ordersForCheckoutFilter =
          allCoIds.size === 0
            ? []
            : ((await Order.find({
                storeId: req.storeId,
                _id: { $in: [...allCoIds].map((id) => new mongoose.Types.ObjectId(id)) },
              })
                .select({ status: 1 })
                .lean()) as Record<string, unknown>[]);
        const orderByIdNum = new Map(ordersForCheckoutFilter.map((o) => [String(o._id), o]));
        checkouts = checkouts.filter((c) => !checkoutTouchesHiddenOrder(c, orderByIdNum));
        const covered = new Set<string>();
        for (const c of checkouts) {
          for (const cid of c.orderIds as mongoose.Types.ObjectId[]) {
            covered.add(cid.toString());
          }
        }
        const fromCheckouts = checkouts.map((c) => mapCheckoutToResult(c, orders));
        const orphanOrders = orders.filter((o) => !covered.has(String(o._id)));
        const merged = [...fromCheckouts, ...orphanOrders.map(syntheticReceiptFromOrder)];
        merged.sort(
          (a, b) =>
            new Date(b.checkedOutAt as string | Date).getTime() -
            new Date(a.checkedOutAt as string | Date).getTime(),
        );
        res.json(merged);
        return;
      }

      checkouts = (await Checkout.find({
        storeId: req.storeId,
        checkedOutAt: { $gte: startOfDay, $lte: endOfDay },
      })
        .sort({ checkedOutAt: -1 })
        .lean()) as Record<string, unknown>[];

      const orderObjectIds: mongoose.Types.ObjectId[] = [];
      for (const c of checkouts) {
        for (const cid of c.orderIds as mongoose.Types.ObjectId[]) {
          orderObjectIds.push(cid);
        }
      }
      const ordersFromCheckouts =
        orderObjectIds.length === 0
          ? []
          : ((await Order.find({
              storeId: req.storeId,
              _id: { $in: orderObjectIds },
            }).lean()) as Record<string, unknown>[]);

      const orderByIdDay = new Map(ordersFromCheckouts.map((o) => [String(o._id), o]));
      const checkoutsVisible = checkouts.filter((c) => !checkoutTouchesHiddenOrder(c, orderByIdDay));
      const fromCheckouts = checkoutsVisible.map((c) => mapCheckoutToResult(c, ordersFromCheckouts));

      /** 任意 Checkout 已关联的订单不再生成虚拟小票，避免与真实结账重复 */
      const orderIdsInAnyCheckout = (await Checkout.distinct('orderIds', {
        storeId: req.storeId,
      })) as mongoose.Types.ObjectId[];

      const orphanDateWindow: Record<string, unknown> = {
        $or: [
          { completedAt: { $gte: startOfDay, $lte: endOfDay } },
          {
            $and: [
              { completedAt: null },
              { createdAt: { $gte: startOfDay, $lte: endOfDay } },
            ],
          },
        ],
      };

      const orphanOrders = (await Order.find({
        storeId: req.storeId,
        status: { $in: [...searchableOrderStatuses] },
        _id: { $nin: orderIdsInAnyCheckout },
        ...orphanDateWindow,
      })
        .sort({ createdAt: -1 })
        .lean()) as Record<string, unknown>[];
      const orphanOrdersVisible = orphanOrders.filter((o) => !statusContainsHide(o.status));

      const fromOrphansOnly = orphanOrdersVisible.map(syntheticReceiptFromOrder);
      const mergedDay = [...fromCheckouts, ...fromOrphansOnly];
      mergedDay.sort(
        (a, b) =>
          new Date(b.checkedOutAt as string | Date).getTime() -
          new Date(a.checkedOutAt as string | Date).getTime(),
      );
      res.json(mergedDay);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/checkout/:checkoutId/refund — Refund specific items from a checkout
  // Body: { itemIds: string[] } — array of order item _id values to refund
  // If itemIds is empty or not provided, refund ALL items (full refund)
  router.post('/:checkoutId/refund', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order, Checkout, Member, MemberWalletTxn } = checkoutModels();
      const { checkoutId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(checkoutId as string)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid checkout ID');
      }

      const { itemIds } = req.body as { itemIds?: string[] };

      const checkout = await Checkout.findOne({ _id: checkoutId, storeId: req.storeId });
      if (!checkout) {
        throw createAppError('NOT_FOUND', 'Checkout not found');
      }

      const orders = await Order.find({ storeId: req.storeId, _id: { $in: checkout.orderIds } });
      if (orders.length === 0) {
        throw createAppError('NOT_FOUND', 'No orders found for this checkout');
      }

      // Collect all items across all orders
      const allItems = orders.flatMap(o => o.items);

      let refundAmount = 0;
      const refundedItemDetails: { itemId: string; itemName: string; quantity: number; unitPrice: number }[] = [];

      if (itemIds && itemIds.length > 0) {
        // Partial refund: mark specific items as refunded
        for (const order of orders) {
          for (const item of order.items) {
            if (itemIds.includes(item._id.toString()) && !item.refunded) {
              item.refunded = true;
              const optExtra = (item.selectedOptions || []).reduce((s: number, o: { extraPrice?: number }) => s + (o.extraPrice || 0), 0);
              refundAmount += (item.unitPrice + optExtra) * item.quantity;
              refundedItemDetails.push({
                itemId: item._id.toString(),
                itemName: item.itemName,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
              });
            }
          }
          // Check if all items in this order are refunded
          const allRefunded = order.items.every((i: { refunded?: boolean }) => i.refunded);
          if (allRefunded) {
            order.status = 'refunded';
          }
          await order.save();
        }
      } else {
        // Full refund: mark all non-refunded items
        for (const order of orders) {
          for (const item of order.items) {
            if (!item.refunded) {
              item.refunded = true;
              const optExtra = (item.selectedOptions || []).reduce((s: number, o: { extraPrice?: number }) => s + (o.extraPrice || 0), 0);
              refundAmount += (item.unitPrice + optExtra) * item.quantity;
              refundedItemDetails.push({
                itemId: item._id.toString(),
                itemName: item.itemName,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
              });
            }
          }
          order.status = 'refunded';
          await order.save();
        }
      }

      if (refundedItemDetails.length === 0) {
        throw createAppError('VALIDATION_ERROR', 'No items to refund (already refunded or invalid item IDs)');
      }

      const refundedEuro = round2Euro(refundAmount);
      let memberWalletRefundEuro = 0;
      let memberWalletRefundError: string | null = null;

      const ch = checkout as mongoose.Document & {
        memberId?: mongoose.Types.ObjectId;
        memberCreditUsed?: number;
        memberCreditRefundedEuro?: number;
        totalAmount?: number;
      };
      const totalCharged = round2Euro(Number(ch.totalAmount) || 0);
      const memberUsed = round2Euro(Number(ch.memberCreditUsed) || 0);
      const alreadyBack = round2Euro(Number(ch.memberCreditRefundedEuro) || 0);
      const memberRemaining = Math.max(0, round2Euro(memberUsed - alreadyBack));

      if (ch.memberId && memberRemaining > 0.001 && totalCharged > 0.001 && refundedEuro > 0) {
        const rawReturn = round2Euro((refundedEuro / totalCharged) * memberUsed);
        memberWalletRefundEuro = Math.min(rawReturn, memberRemaining, refundedEuro);
        memberWalletRefundEuro = round2Euro(memberWalletRefundEuro);
        if (memberWalletRefundEuro > 0.001) {
          try {
            await creditMemberWallet({
              Member,
              MemberWalletTxn,
              storeId: req.storeId!,
              memberId: ch.memberId,
              amountEuro: memberWalletRefundEuro,
              type: 'refund_credit',
              checkoutId: new mongoose.Types.ObjectId(checkoutId as string),
              note: `订单退款退回储值（退款额 €${refundedEuro}）`,
            });
            ch.memberCreditRefundedEuro = round2Euro(alreadyBack + memberWalletRefundEuro);
            await ch.save();
          } catch (e) {
            memberWalletRefundError = e instanceof Error ? e.message : 'member wallet refund failed';
          }
        }
      }

      io.to(storeIoRoom(req.storeId!)).emit('order:refunded', {
        checkoutId,
        refundedItems: refundedItemDetails,
        refundAmount: refundedEuro,
        memberWalletRefundEuro,
      });

      const co = checkout as mongoose.Document & {
        paymentMethod?: string;
        cashAmount?: number;
        cardAmount?: number;
      };
      const refundChannelBreakdown = computeRefundChannelBreakdown({
        refundedAmount: refundedEuro,
        memberWalletRefundEuro,
        paymentMethod: String(co.paymentMethod || 'cash'),
        cashAmount: Number(co.cashAmount) || 0,
        cardAmount: Number(co.cardAmount) || 0,
      });

      res.json({
        message: 'Refund successful',
        checkoutId,
        refundedAmount: refundedEuro,
        refundedItems: refundedItemDetails,
        memberWalletRefundEuro,
        refundChannelBreakdown,
        ...(memberWalletRefundError ? { memberWalletRefundError } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

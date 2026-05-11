import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { getBusinessStatus } from '../utils/businessHours';
import { mergeTemplateOptionGroupsForItem, type MenuItemLike } from '../utils/optionGroupTemplateApply';
import type { LeanOptionGroup } from '../utils/optionGroups';
import { storeIoRoom } from '../socketRooms';
import { resolveStoreEffectiveFeatures, FeatureKeys } from '../utils/featureCatalog';
import {
  DELIVERY_FEE_RULES_CONFIG_KEY,
  deliveryFeeForDistance,
  parseDeliveryFeeRulesJson,
} from '../utils/deliveryFeeRules';
import { computeOrderPayableTotalEuro } from '../utils/orderPayableTotal';
import { optionalAuthMiddleware, requirePermission } from '../middleware/auth';
import { Role } from '../middleware/permissions';
import { requireAuthSameStore } from '../middleware/authForStore';
import { customerPhoneMatchCandidates, normalizeMemberPhone } from '../utils/memberWalletOps';
import { attachCustomerProfileToDeliveryOrder } from '../utils/customerProfileDelivery';
import { aggregateFrequentMenuItemsForCustomer } from '../utils/customerFrequentOrderItems';
import { zonedDayBoundsForRef } from '../utils/zonedDayBounds';

function orderModels() {
  return getModels() as {
    MenuItem: mongoose.Model<any>;
    Order: mongoose.Model<any>;
    DailyOrderCounter: mongoose.Model<any>;
    SystemConfig: mongoose.Model<any>;
    CustomerProfile: mongoose.Model<any>;
  };
}

type MenuItemForOrder = MenuItemLike & {
  translations?: { locale: string; name: string }[];
  price: number;
  isSoldOut?: boolean;
};

export function createOrdersRouter(io: SocketIOServer): Router {
  const router = Router();
  const ACTIVE_ORDER_STATUSES = ['pending', 'paid_online', 'checked_out'] as const;

  type SelectedOptInput = { groupId: string; choiceId: string };

  async function snapshotSelectedOptionsFromMenuItem(
    storeId: mongoose.Types.ObjectId,
    menuItem: MenuItemForOrder,
    selectedOptions: SelectedOptInput[] | undefined,
  ): Promise<{ groupName: string; groupNameEn: string; choiceName: string; choiceNameEn: string; extraPrice: number }[]> {
    if (!selectedOptions || !Array.isArray(selectedOptions) || selectedOptions.length === 0) return [];

    const merged = await mergeTemplateOptionGroupsForItem(storeId, {
      _id: menuItem._id,
      categoryId: menuItem.categoryId,
      optionGroups: (menuItem.optionGroups || []) as unknown as LeanOptionGroup[],
    });

    const snapshots: { groupName: string; groupNameEn: string; choiceName: string; choiceNameEn: string; extraPrice: number }[] = [];
    for (const sel of selectedOptions) {
      if (!sel.groupId || !mongoose.Types.ObjectId.isValid(sel.groupId)) {
        throw createAppError('VALIDATION_ERROR', `Invalid groupId: ${sel.groupId}`);
      }
      if (!sel.choiceId || !mongoose.Types.ObjectId.isValid(sel.choiceId)) {
        throw createAppError('VALIDATION_ERROR', `Invalid choiceId: ${sel.choiceId}`);
      }

      const group = merged.find((g) => g._id && g._id.toString() === sel.groupId);
      if (!group) {
        throw createAppError('VALIDATION_ERROR', `Unknown option group: ${sel.groupId}`);
      }
      const choice = group.choices.find((c) => c._id && c._id.toString() === sel.choiceId);
      if (!choice) {
        throw createAppError('VALIDATION_ERROR', `Unknown option choice: ${sel.choiceId}`);
      }

      const groupName = group.translations.find((t) => t.locale === 'zh-CN')?.name || group.translations[0]?.name || '';
      const groupNameEn = group.translations.find((t) => t.locale === 'en-US')?.name || groupName;
      const choiceName = choice.translations.find((t) => t.locale === 'zh-CN')?.name || choice.translations[0]?.name || '';
      const choiceNameEn = choice.translations.find((t) => t.locale === 'en-US')?.name || choiceName;

      snapshots.push({
        groupName,
        groupNameEn,
        choiceName,
        choiceNameEn,
        extraPrice: typeof choice.extraPrice === 'number' ? choice.extraPrice : 0,
      });
    }

    return snapshots;
  }

  async function buildOrderItemsPayload(
    storeId: mongoose.Types.ObjectId,
    items: { menuItemId: string; quantity: number; selectedOptions?: SelectedOptInput[] }[],
    menuItemMap: Map<string, MenuItemForOrder>,
  ) {
    const orderItems: {
      menuItemId?: string;
      lineKind?: string;
      quantity: number;
      unitPrice: number;
      itemName: string;
      itemNameEn: string;
      selectedOptions: { groupName: string; groupNameEn: string; choiceName: string; choiceNameEn: string; extraPrice: number }[];
    }[] = [];

    for (const item of items) {
      const menuItem = menuItemMap.get(item.menuItemId)!;
      const zhTrans = menuItem.translations?.find((t: { locale: string }) => t.locale === 'zh-CN');
      const enTrans = menuItem.translations?.find((t: { locale: string }) => t.locale === 'en-US');
      const itemName = zhTrans?.name || enTrans?.name || (menuItem.translations?.[0] as { name: string })?.name || 'Unknown';
      const itemNameEn = enTrans?.name || zhTrans?.name || itemName;
      const selectedOptions = await snapshotSelectedOptionsFromMenuItem(storeId, menuItem, item.selectedOptions);

      orderItems.push({
        menuItemId: item.menuItemId,
        lineKind: 'menu',
        quantity: item.quantity,
        unitPrice: menuItem.price,
        itemName,
        itemNameEn,
        selectedOptions,
      });
    }

    return orderItems;
  }

  function appendDeliveryFeeLineToOrderItems(orderItems: Record<string, unknown>[], orderType: string, feeEuro: number) {
    if (orderType !== 'delivery' || !(feeEuro > 0)) return;
    orderItems.push({
      lineKind: 'delivery_fee',
      quantity: 1,
      unitPrice: feeEuro,
      itemName: '送餐费',
      itemNameEn: 'Delivery fee',
      selectedOptions: [],
    });
  }

  // POST /api/orders — Create a new order（可选 Bearer：店员创建外卖时标记 takeoutPlacementSource）
  router.post('/', optionalAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuItem, Order, DailyOrderCounter, SystemConfig, CustomerProfile } = orderModels();
      const {
        type,
        tableNumber,
        seatNumber,
        items,
        appliedBundles,
        customerName,
        customerPhone,
        deliveryAddress,
        postalCode,
        deliverySource,
        deliveryDistanceKm: rawDeliveryDistanceKm,
        pickupSlotLabel: rawPickupSlotLabel,
        pickupSlotStart: rawPickupSlotStart,
        customerProfileId: rawCustomerProfileId,
      } = req.body;

      // Customer self-order channels follow business hour restrictions.
      if (type === 'dine_in' || type === 'takeout') {
        const status = await getBusinessStatus(req.storeId!);
        if (!status.isOpen) {
          throw createAppError('VALIDATION_ERROR', 'Restaurant is currently closed', {
            businessStatus: status,
          });
        }
      }

      // Validate type
      if (!type || !['dine_in', 'takeout', 'phone', 'delivery'].includes(type)) {
        throw createAppError('VALIDATION_ERROR', 'type must be "dine_in", "takeout", "phone", or "delivery"');
      }

      // For dine_in, require tableNumber and seatNumber
      if (type === 'dine_in') {
        if (tableNumber == null || typeof tableNumber !== 'number') {
          throw createAppError('VALIDATION_ERROR', 'tableNumber is required for dine_in orders');
        }
        if (seatNumber == null || typeof seatNumber !== 'number') {
          throw createAppError('VALIDATION_ERROR', 'seatNumber is required for dine_in orders');
        }
      }
      if (type === 'delivery') {
        const features = await resolveStoreEffectiveFeatures(req.storeId!);
        if (!features.has(FeatureKeys.CashierDeliveryPage)) {
          throw createAppError('FORBIDDEN', '当前套餐未开通送餐功能');
        }
        const name = typeof customerName === 'string' ? customerName.trim() : '';
        const phone = typeof customerPhone === 'string' ? customerPhone.trim() : '';
        const addr = typeof deliveryAddress === 'string' ? deliveryAddress.trim() : '';
        const pc = typeof postalCode === 'string' ? postalCode.trim() : '';
        const src = typeof deliverySource === 'string' ? deliverySource.trim() : '';
        if (!name || !phone || !addr || !pc) {
          throw createAppError('VALIDATION_ERROR', 'delivery orders require customerName, customerPhone, deliveryAddress, and postalCode');
        }
        if (src !== 'phone' && src !== 'qr') {
          throw createAppError('VALIDATION_ERROR', 'deliverySource must be "phone" or "qr"');
        }
      }

      // Validate items array
      if (!Array.isArray(items) || items.length === 0) {
        throw createAppError('VALIDATION_ERROR', 'items must be a non-empty array');
      }

      for (const item of items) {
        if (!item.menuItemId || !mongoose.Types.ObjectId.isValid(item.menuItemId)) {
          throw createAppError('VALIDATION_ERROR', `Invalid menuItemId: ${item.menuItemId}`);
        }
        if (!item.quantity || typeof item.quantity !== 'number' || item.quantity < 1) {
          throw createAppError('VALIDATION_ERROR', 'Each item must have a quantity >= 1');
        }
      }

      // Fetch all referenced menu items
      const menuItemIds = items.map((i: { menuItemId: string }) => i.menuItemId);
      const menuItems = await MenuItem.find({ storeId: req.storeId, _id: { $in: menuItemIds } });

      // Check all items exist
      const foundIds = new Set(menuItems.map((m) => m._id.toString()));
      const missingIds = menuItemIds.filter((id: string) => !foundIds.has(id));
      if (missingIds.length > 0) {
        throw createAppError('VALIDATION_ERROR', `Menu items not found: ${missingIds.join(', ')}`);
      }

      // Check for sold out items
      const soldOutItems = menuItems.filter((m) => m.isSoldOut);
      if (soldOutItems.length > 0) {
        throw createAppError('ITEM_SOLD_OUT', 'Some items are sold out', {
          soldOutItemIds: soldOutItems.map((m) => m._id.toString()),
        });
      }

      // Build a lookup map for menu items
      const menuItemMap = new Map(menuItems.map((m) => [m._id.toString(), m as MenuItemForOrder]));

      // Build order items with price/name snapshots
      const orderItems = await buildOrderItemsPayload(req.storeId!, items, menuItemMap);
      const orderData: Record<string, unknown> = {
        storeId: req.storeId,
        type,
        status: 'pending',
        items: orderItems,
        appliedBundles: Array.isArray(appliedBundles) ? appliedBundles : [],
      };

      if (type === 'dine_in') {
        orderData.tableNumber = tableNumber;
        orderData.seatNumber = seatNumber;
        // Generate 6-digit order number: HHmmss
        const now = new Date();
        orderData.dineInOrderNumber =
          String(now.getHours()).padStart(2, '0') +
          String(now.getMinutes()).padStart(2, '0') +
          String(now.getSeconds()).padStart(2, '0');
      }

      if (type === 'takeout' || type === 'phone') {
        const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const counter = await DailyOrderCounter.findOneAndUpdate(
          { storeId: req.storeId, date: todayStr },
          { $inc: { currentNumber: 1 }, $setOnInsert: { storeId: req.storeId, date: todayStr } },
          { upsert: true, returnDocument: 'after' }
        );
        orderData.dailyOrderNumber = counter!.currentNumber;
      }
      if (type === 'delivery') {
        const todayStr = new Date().toISOString().slice(0, 10);
        const counter = await DailyOrderCounter.findOneAndUpdate(
          { storeId: req.storeId, date: todayStr },
          { $inc: { currentNumber: 1 }, $setOnInsert: { storeId: req.storeId, date: todayStr } },
          { upsert: true, returnDocument: 'after' }
        );
        orderData.dailyOrderNumber = counter!.currentNumber;
        orderData.customerName = String(customerName || '').trim();
        {
          const rawPhone = String(customerPhone || '').trim();
          const normPhone = normalizeMemberPhone(rawPhone);
          orderData.customerPhone =
            normPhone.length >= 8 ? normPhone : rawPhone.replace(/\D/g, '') || rawPhone;
        }
        orderData.deliveryAddress = String(deliveryAddress || '').trim();
        orderData.postalCode = String(postalCode || '').trim();
        orderData.deliverySource = String(deliverySource || '').trim();
        orderData.deliveryStage = 'new';

        const feeRow = await SystemConfig.findOne({ storeId: req.storeId, key: DELIVERY_FEE_RULES_CONFIG_KEY }).lean();
        const deliveryRules = parseDeliveryFeeRulesJson((feeRow as { value?: string } | null)?.value);

        let dist: number | undefined;
        const rawD = rawDeliveryDistanceKm;
        if (typeof rawD === 'number' && Number.isFinite(rawD) && rawD >= 0) {
          dist = rawD;
        } else if (rawD != null && rawD !== '' && typeof rawD === 'string') {
          const p = parseFloat(String(rawD).trim());
          if (Number.isFinite(p) && p >= 0) dist = p;
        }

        let fee = 0;
        if (deliveryRules.length > 0) {
          if (dist === undefined) {
            throw createAppError(
              'VALIDATION_ERROR',
              '已配置距离阶梯送餐费：需提供 deliveryDistanceKm（公里，可由邮编解析）',
            );
          }
          fee = deliveryFeeForDistance(deliveryRules, dist);
        }

        if (dist !== undefined) orderData.deliveryDistanceKm = dist;
        orderData.deliveryFeeEuro = fee;
        appendDeliveryFeeLineToOrderItems(orderItems as Record<string, unknown>[], type, fee);

        const reqProf =
          typeof rawCustomerProfileId === 'string' && mongoose.Types.ObjectId.isValid(rawCustomerProfileId)
            ? rawCustomerProfileId
            : null;
        const profileId = await attachCustomerProfileToDeliveryOrder({
          CustomerProfile,
          storeId: req.storeId!,
          phoneRaw: String(customerPhone || ''),
          customerName: String(customerName || ''),
          deliveryAddress: String(deliveryAddress || ''),
          postalCode: String(postalCode || ''),
          deliverySource: String(deliverySource || '').trim() === 'qr' ? 'qr' : 'phone',
          requestedProfileId: reqProf,
        });
        orderData.customerProfileId = profileId;
      }

      if (type === 'takeout') {
        const label = typeof rawPickupSlotLabel === 'string' ? rawPickupSlotLabel.trim() : '';
        if (label) {
          orderData.pickupSlotLabel = label.slice(0, 80);
        }
        if (rawPickupSlotStart != null && rawPickupSlotStart !== '') {
          const d = new Date(rawPickupSlotStart as string);
          if (!Number.isNaN(d.getTime())) {
            orderData.pickupSlotStart = d;
          }
        }
        const u = req.user;
        const isCashierPlacement =
          !!req.storeId &&
          !!u &&
          u.role !== 'platform_owner' &&
          u.storeId === req.storeId.toString() &&
          (u.role === Role.OWNER || u.role === Role.CASHIER);
        orderData.takeoutPlacementSource = isCashierPlacement ? 'cashier' : 'customer';
      }

      if (type === 'phone') {
        const rawPhone = typeof customerPhone === 'string' ? customerPhone.trim() : '';
        if (rawPhone) {
          const normPhone = normalizeMemberPhone(rawPhone);
          orderData.customerPhone =
            normPhone.length >= 8 ? normPhone : rawPhone.replace(/\D/g, '') || rawPhone;
        }
        const name = typeof customerName === 'string' ? customerName.trim() : '';
        if (name) {
          orderData.customerName = name;
        }
      }

      const order = await Order.create(orderData);

      io.to(storeIoRoom(req.storeId!)).emit('order:new', order);

      res.status(201).json(order);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/orders/dine-in — Get pending and paid_online dine-in orders
  router.get('/dine-in', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = orderModels();
      const orders = await Order.find({ storeId: req.storeId, type: 'dine_in', status: { $in: ['pending', 'paid_online'] } }).sort({ tableNumber: 1, seatNumber: 1 });
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/orders/dine-in/active?table=X&seat=Y — Get active orders for a specific table/seat
  router.get('/dine-in/active', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { table, seat } = req.query;
      if (!table || !seat) {
        return res.json([]);
      }
      const { Order } = orderModels();
      const orders = await Order.find({
        storeId: req.storeId,
        type: 'dine_in',
        tableNumber: Number(table),
        seatNumber: Number(seat),
        status: { $in: ['pending', 'paid_online'] },
      }).sort({ createdAt: -1 });
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/orders/takeout — Get pending (not checked out) takeout orders sorted by dailyOrderNumber ASC
  router.get('/takeout', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = orderModels();
      const orders = await Order.find({ storeId: req.storeId, type: 'takeout', status: { $in: ['pending', 'paid_online'] } }).sort({ dailyOrderNumber: 1 });
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/orders/phone — Get pending phone orders sorted by dailyOrderNumber ASC
  router.get('/phone', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = orderModels();
      const orders = await Order.find({ storeId: req.storeId, type: 'phone', status: 'pending' }).sort({ dailyOrderNumber: 1 });
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/orders/active-all — unified active queue for cashier order center
  router.get('/active-all', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = orderModels();
      /** 仅「当前店铺 + 当地日历当日 00:00～次日 00:00」内创建的订单（左闭右开），避免历史 checked_out 等占满队列 */
      const tz = process.env.CASHIER_ACTIVE_ORDER_TIMEZONE?.trim() || 'Europe/Dublin';
      const { start: dayStart, endExclusive: dayEndExclusive } = zonedDayBoundsForRef(new Date(), tz);
      const orders = await Order.find({
        storeId: req.storeId,
        createdAt: { $gte: dayStart, $lt: dayEndExclusive },
        $or: [
          // Dine-in and takeout keep existing active statuses.
          {
            type: { $in: ['dine_in', 'takeout'] },
            status: { $in: [...ACTIVE_ORDER_STATUSES] },
          },
          // Phone orders should disappear after checkout.
          {
            type: 'phone',
            status: 'pending',
          },
          // 电话送餐：司机回店结账后应为 completed；队列中只保留待处理/待收款阶段（勿含 checked_out，否则旧数据会永远占位）
          {
            type: 'delivery',
            deliverySource: 'phone',
            status: { $in: ['pending', 'paid_online'] },
          },
          // Delivery orders from QR appear in cashier only after payment.
          {
            type: 'delivery',
            deliverySource: 'qr',
            status: { $in: ['paid_online', 'checked_out'] },
          },
          // Backward compatibility for old delivery rows without source.
          {
            type: 'delivery',
            deliverySource: { $exists: false },
            status: { $in: ['pending', 'paid_online'] },
          },
        ],
      })
        .sort({
          type: 1,
          status: 1,
          tableNumber: 1,
          seatNumber: 1,
          dailyOrderNumber: 1,
          createdAt: 1,
        })
        .lean();
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/orders/takeout/pending — Get checked_out (not completed) takeout orders
  router.get('/takeout/pending', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = orderModels();
      const orders = await Order.find({ storeId: req.storeId, type: 'takeout', status: 'checked_out' }).sort({ dailyOrderNumber: 1 });
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/orders/takeout/:id/complete — Mark takeout order as completed
  router.put('/takeout/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = orderModels();
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }

      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }

      if (order.type !== 'takeout') {
        throw createAppError('VALIDATION_ERROR', 'Only takeout orders can be marked as completed via this endpoint');
      }

      if (order.status !== 'checked_out') {
        throw createAppError('VALIDATION_ERROR', 'Only checked_out takeout orders can be marked as completed', {
          currentStatus: order.status,
        });
      }

      const updated = await Order.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        { $set: { status: 'completed', completedAt: new Date() } },
        { new: true },
      );
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/orders/takeout/:id/complete-online-paid
  // QR/self takeout already paid online: cashier prints and marks completed + creates online checkout for reports.
  router.put('/takeout/:id/complete-online-paid', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const models = getModels() as {
        Order: mongoose.Model<any>;
        Checkout: mongoose.Model<any>;
        MemberWalletTxn: mongoose.Model<any>;
      };
      const { Order, Checkout, MemberWalletTxn } = models;
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }

      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) throw createAppError('NOT_FOUND', 'Order not found');
      if (order.type !== 'takeout') {
        throw createAppError('VALIDATION_ERROR', 'Only takeout orders can use this action');
      }
      if (order.status !== 'paid_online') {
        throw createAppError('VALIDATION_ERROR', 'Only online-paid takeout orders can be finished here', {
          currentStatus: order.status,
        });
      }

      const totalAmount = computeOrderPayableTotalEuro(order);
      const stripePi = String(order.stripePaymentIntentId || '').trim();
      const memberUsed = Number(order.memberCreditUsed) || 0;
      const memberPrepaid = !stripePi && memberUsed > 0.001 && order.memberId;

      if (memberPrepaid && Math.abs(totalAmount - memberUsed) > 0.02) {
        throw createAppError('VALIDATION_ERROR', '订单金额与已扣储值不一致，请核对订单', {
          totalAmount,
          memberCreditUsed: memberUsed,
        });
      }

      const checkoutPayload: Record<string, unknown> = {
        storeId: req.storeId,
        type: 'seat',
        totalAmount,
        paymentMethod: memberPrepaid ? 'member' : 'online',
        orderIds: [order._id],
        tableNumber: order.tableNumber,
      };
      if (memberPrepaid) {
        checkoutPayload.memberId = order.memberId;
        checkoutPayload.memberPhoneSnapshot = String(order.memberPhoneSnapshot || '');
        checkoutPayload.memberCreditUsed = memberUsed;
      }

      const checkout = await Checkout.create(checkoutPayload);

      if (memberPrepaid) {
        await MemberWalletTxn.updateMany(
          {
            storeId: req.storeId,
            orderId: order._id,
            type: 'spend',
            $or: [{ checkoutId: { $exists: false } }, { checkoutId: null }],
          },
          { $set: { checkoutId: checkout._id } },
        );
      }

      const updated = await Order.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        { $set: { status: 'completed', completedAt: new Date() } },
        { new: true },
      );
      io.to(storeIoRoom(req.storeId!)).emit('order:updated', updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/orders/dine-in/:id/complete-online-paid
  // Customer QR dine-in already paid online: after cashier prints kitchen ticket, mark completed + checkout record for reporting.
  router.put('/dine-in/:id/complete-online-paid', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const models = getModels() as {
        Order: mongoose.Model<any>;
        Checkout: mongoose.Model<any>;
        MemberWalletTxn: mongoose.Model<any>;
      };
      const { Order, Checkout, MemberWalletTxn } = models;
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }

      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }

      if (order.type !== 'dine_in') {
        throw createAppError('VALIDATION_ERROR', 'Only dine-in orders can use this action');
      }

      if (order.status !== 'paid_online') {
        throw createAppError('VALIDATION_ERROR', 'Only online-paid dine-in orders can be finished here', {
          currentStatus: order.status,
        });
      }

      const itemTotal = order.items.reduce((sum: number, item: { unitPrice: number; quantity: number; selectedOptions?: { extraPrice?: number }[] }) => {
        const optExtra = (item.selectedOptions || []).reduce((s: number, o: { extraPrice?: number }) => s + (o.extraPrice || 0), 0);
        return sum + (item.unitPrice + optExtra) * item.quantity;
      }, 0);
      const bundleDiscount = ((order as unknown as { appliedBundles?: { discount: number }[] }).appliedBundles || [])
        .reduce((s: number, b: { discount: number }) => s + b.discount, 0);
      const totalAmount = Math.round((itemTotal - bundleDiscount) * 100) / 100;

      const stripePi = String(order.stripePaymentIntentId || '').trim();
      const memberUsed = Number(order.memberCreditUsed) || 0;
      const memberPrepaid = !stripePi && memberUsed > 0.001 && order.memberId;

      if (memberPrepaid && Math.abs(totalAmount - memberUsed) > 0.02) {
        throw createAppError('VALIDATION_ERROR', '订单金额与已扣储值不一致，请核对订单', {
          totalAmount,
          memberCreditUsed: memberUsed,
        });
      }

      const checkoutPayload: Record<string, unknown> = {
        storeId: req.storeId,
        type: 'seat',
        totalAmount,
        paymentMethod: memberPrepaid ? 'member' : 'online',
        orderIds: [order._id],
        tableNumber: order.tableNumber,
      };
      if (memberPrepaid) {
        checkoutPayload.memberId = order.memberId;
        checkoutPayload.memberPhoneSnapshot = String(order.memberPhoneSnapshot || '');
        checkoutPayload.memberCreditUsed = memberUsed;
      }

      const checkout = await Checkout.create(checkoutPayload);

      if (memberPrepaid) {
        await MemberWalletTxn.updateMany(
          {
            storeId: req.storeId,
            orderId: order._id,
            type: 'spend',
            $or: [{ checkoutId: { $exists: false } }, { checkoutId: null }],
          },
          { $set: { checkoutId: checkout._id } },
        );
      }

      const updated = await Order.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        { $set: { status: 'completed', completedAt: new Date() } },
        { new: true },
      );

      io.to(storeIoRoom(req.storeId!)).emit('order:updated', updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/orders/:id/delivery-stage — update delivery workflow stage without changing checkout status
  router.put('/:id/delivery-stage', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const features = await resolveStoreEffectiveFeatures(req.storeId!);
      if (!features.has(FeatureKeys.CashierDeliveryPage)) {
        throw createAppError('FORBIDDEN', '当前套餐未开通送餐功能');
      }
      const { Order } = orderModels();
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }
      const nextStage = typeof req.body?.deliveryStage === 'string' ? req.body.deliveryStage.trim() : '';
      const allowed = new Set(['new', 'accepted', 'picked_up_by_driver', 'out_for_delivery']);
      if (!allowed.has(nextStage)) {
        throw createAppError('VALIDATION_ERROR', 'deliveryStage must be one of new/accepted/picked_up_by_driver/out_for_delivery');
      }

      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }
      if (order.type !== 'delivery') {
        throw createAppError('VALIDATION_ERROR', 'Only delivery orders can update delivery stage');
      }
      order.deliveryStage = nextStage;
      // Delivery business rule: once driver has picked up and payment is already settled,
      // treat as delivered+done (no separate delivered step needed).
      if (nextStage === 'picked_up_by_driver' && (order.status === 'checked_out' || order.status === 'paid_online')) {
        order.status = 'completed';
        order.completedAt = new Date();
      }
      await order.save();
      io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/orders/customer-frequent-items — 近 N 天常点菜品（收银建议；须置于 /:id 之前）
  router.get(
    '/customer-frequent-items',
    ...requireAuthSameStore,
    requirePermission('checkout:process'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { Order } = orderModels();
        const qRaw = String(req.query.phone || '');
        const candidates = customerPhoneMatchCandidates(qRaw);
        if (candidates.length === 0) {
          res.json([]);
          return;
        }
        const days = Math.min(90, Math.max(1, Number(req.query.days) || 60));
        const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));
        const list = await aggregateFrequentMenuItemsForCustomer(Order, req.storeId!, candidates, {
          days,
          limit,
        });
        res.json(list);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/orders/customer-profiles — 按手机号列举送餐客户档案（须置于 /:id 之前）
  router.get('/customer-profiles', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { CustomerProfile } = orderModels();
      const phone = normalizeMemberPhone(String(req.query.phone || ''));
      if (!phone) {
        res.json([]);
        return;
      }
      const list = await CustomerProfile.find({ storeId: req.storeId, phoneNorm: phone })
        .sort({ updatedAt: -1 })
        .limit(30)
        .lean();
      res.json(
        list.map((p: Record<string, unknown>) => ({
          _id: p._id,
          customerName: String(p.customerName || ''),
          deliveryAddress: String(p.deliveryAddress || ''),
          postalCode: String(p.postalCode || ''),
          memberId: p.memberId || null,
          updatedAt: p.updatedAt,
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  // GET /api/orders/:id — Get order details
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = orderModels();
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }

      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }

      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/orders/:id/items — Modify order items
  router.put('/:id/items', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { MenuItem, Order } = orderModels();
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }

      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }

      // Only pending orders can be modified
      if (order.status !== 'pending') {
        throw createAppError('ORDER_NOT_MODIFIABLE', 'Order cannot be modified', {
          currentStatus: order.status,
        });
      }

      const { items } = req.body;

      // Validate items array
      if (!Array.isArray(items) || items.length === 0) {
        throw createAppError('VALIDATION_ERROR', 'items must be a non-empty array');
      }

      for (const item of items) {
        if (!item.menuItemId || !mongoose.Types.ObjectId.isValid(item.menuItemId)) {
          throw createAppError('VALIDATION_ERROR', `Invalid menuItemId: ${item.menuItemId}`);
        }
        if (!item.quantity || typeof item.quantity !== 'number' || item.quantity < 1) {
          throw createAppError('VALIDATION_ERROR', 'Each item must have a quantity >= 1');
        }
      }

      // Fetch all referenced menu items
      const menuItemIds = items.map((i: { menuItemId: string }) => i.menuItemId);
      const menuItems = await MenuItem.find({ storeId: req.storeId, _id: { $in: menuItemIds } });

      // Check all items exist
      const foundIds = new Set(menuItems.map((m) => m._id.toString()));
      const missingIds = menuItemIds.filter((id: string) => !foundIds.has(id));
      if (missingIds.length > 0) {
        throw createAppError('VALIDATION_ERROR', `Menu items not found: ${missingIds.join(', ')}`);
      }

      // Check for sold out items
      const soldOutItems = menuItems.filter((m) => m.isSoldOut);
      if (soldOutItems.length > 0) {
        throw createAppError('ITEM_SOLD_OUT', 'Some items are sold out', {
          soldOutItemIds: soldOutItems.map((m) => m._id.toString()),
        });
      }

      // Build a lookup map for menu items
      const menuItemMap = new Map(menuItems.map((m) => [m._id.toString(), m as MenuItemForOrder]));

      // Build updated order items with price/name snapshots
      const orderItems = await buildOrderItemsPayload(req.storeId!, items, menuItemMap);
      appendDeliveryFeeLineToOrderItems(
        orderItems as Record<string, unknown>[],
        order.type,
        Number(order.deliveryFeeEuro) || 0,
      );

      const updated = await Order.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        { $set: { items: orderItems } },
        { new: true },
      );

      io.to(storeIoRoom(req.storeId!)).emit('order:updated', updated);

      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/orders/:id — Cancel/delete a pending order
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = orderModels();
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }

      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }

      if (order.status !== 'pending') {
        throw createAppError('ORDER_NOT_MODIFIABLE', 'Only pending orders can be cancelled', {
          currentStatus: order.status,
        });
      }

      await Order.findOneAndDelete({ _id: id, storeId: req.storeId });

      io.to(storeIoRoom(req.storeId!)).emit('order:cancelled', { orderId: id, tableNumber: order.tableNumber });

      res.json({ message: 'Order cancelled successfully' });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/orders/:id/toggle-hide — Toggle hide status for cash orders
  router.put('/:id/toggle-hide', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = orderModels();
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }

      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }

      // Toggle between normal and hide status
      const toggleMap: Record<string, string> = {
        'completed': 'completed-hide',
        'completed-hide': 'completed',
        'checked_out': 'checked_out-hide',
        'checked_out-hide': 'checked_out',
      };

      const newStatus = toggleMap[order.status];
      if (!newStatus) {
        throw createAppError('VALIDATION_ERROR', 'Order status cannot be toggled', {
          currentStatus: order.status,
        });
      }

      const updated = await Order.findOneAndUpdate(
        { _id: id, storeId: req.storeId },
        { $set: { status: newStatus } },
        { new: true },
      );

      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

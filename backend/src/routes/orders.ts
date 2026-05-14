import { Router, Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';
import { getModels } from '../getModels';
import { createAppError } from '../middleware/errorHandler';
import { getBusinessStatus } from '../utils/businessHours';
import { mergeTemplateOptionGroupsForItem, type MenuItemLike } from '../utils/optionGroupTemplateApply';
import { optionGroupSelectionBounds, type LeanOptionGroup } from '../utils/optionGroups';
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
import { getDineInWorkflowModeForStore } from '../utils/dineInWorkflowMode';
import { assertDineInItemsAdditiveOnly, mergeDineInKitchenPrintedAndSettledFromPrevious } from '../utils/dineInPayAfterItems';

function isStaffCashierOrOwner(req: Request): boolean {
  const u = req.user;
  return !!(
    u &&
    u.role !== 'platform_owner' &&
    req.storeId &&
    u.storeId === req.storeId.toString() &&
    (u.role === Role.OWNER || u.role === Role.CASHIER)
  );
}

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

    const countsByGroup = new Map<string, number>();
    for (const sel of selectedOptions) {
      if (!sel.groupId || !mongoose.Types.ObjectId.isValid(sel.groupId)) continue;
      if (!sel.choiceId || !mongoose.Types.ObjectId.isValid(sel.choiceId)) continue;
      countsByGroup.set(sel.groupId, (countsByGroup.get(sel.groupId) || 0) + 1);
    }
    for (const g of merged) {
      const gid = g._id?.toString();
      if (!gid) continue;
      const n = countsByGroup.get(gid) || 0;
      const { min, max } = optionGroupSelectionBounds(g);
      if (n < min) {
        const gn = g.translations?.find((t) => t.locale === 'zh-CN')?.name || g.translations?.[0]?.name || gid;
        throw createAppError('VALIDATION_ERROR', `选项组「${gn}」至少需选 ${min} 项（当前 ${n} 项）`);
      }
      if (max > 0 && n > max) {
        const gn = g.translations?.find((t) => t.locale === 'zh-CN')?.name || g.translations?.[0]?.name || gid;
        throw createAppError('VALIDATION_ERROR', `选项组「${gn}」最多可选 ${max} 项（当前 ${n} 项）`);
      }
    }

    const snapshots: { groupName: string; groupNameEn: string; choiceName: string; choiceNameEn: string; extraPrice: number }[] = [];
    for (const sel of selectedOptions) {
      if (!sel.groupId || !mongoose.Types.ObjectId.isValid(sel.groupId)) {
        throw createAppError('VALIDATION_ERROR', `Invalid groupId: ${sel.groupId}`);
      }
      if (!sel.choiceId || !mongoose.Types.ObjectId.isValid(sel.choiceId)) {
        throw createAppError('VALIDATION_ERROR', `Invalid choiceId: ${sel.choiceId}`);
      }

      let group = merged.find((g) => g._id && g._id.toString() === sel.groupId);
      // 客户端 groupId 可能与当前合并结果不一致（名称回退错组、旧缓存、模板子文档 _id 变更等），
      // 若 choiceId 仍落在合并后的某一组内，则按 choice 反查组，避免堂食/外卖下单失败。
      if (!group) {
        group = merged.find((g) =>
          (g.choices || []).some((c) => c._id && c._id.toString() === sel.choiceId),
        );
      }
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
        const dineInWf = await getDineInWorkflowModeForStore(req.storeId!);
        const rawGuest =
          typeof (req.body as { dineInGuestLabel?: unknown }).dineInGuestLabel === 'string'
            ? String((req.body as { dineInGuestLabel: string }).dineInGuestLabel).trim()
            : '';
        orderData.dineInGuestLabel = rawGuest.slice(0, 40);
        if (dineInWf === 'pay_after') {
          // 首次下单对店端可见；顾客点「改单」会先调 dine-in-exposed 隐藏
          orderData.dineInExposedToStaff = true;
        }
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
      const q: Record<string, unknown> = {
        storeId: req.storeId,
        type: 'dine_in',
        status: { $in: ['pending', 'paid_online'] },
        /** 与后结「改单中隐藏」一致：先付下也必须排除，否则切换流程后顾客扫码仍被旧单劫持 */
        dineInExposedToStaff: { $ne: false },
      };
      const orders = await Order.find(q).sort({ tableNumber: 1, seatNumber: 1 });
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
      const q: Record<string, unknown> = {
        storeId: req.storeId,
        type: 'dine_in',
        tableNumber: Number(table),
        seatNumber: Number(seat),
        status: { $in: ['pending', 'paid_online'] },
        /** 后结改单隐藏时 dineInExposedToStaff=false；先付扫码不应把这类单当作「本座未完成」 */
        dineInExposedToStaff: { $ne: false },
      };
      const orders = await Order.find(q).sort({ createdAt: -1 });
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
      /** 当地日历当日 00:00～次日 00:00（左闭右开）各扩 1h，减少跨日/时钟边界订单漏出订单中心 */
      const tz = process.env.CASHIER_ACTIVE_ORDER_TIMEZONE?.trim() || 'Europe/Dublin';
      const { start: dayStart, endExclusive: dayEndExclusive } = zonedDayBoundsForRef(new Date(), tz);
      const hourMs = 3600 * 1000;
      const activeAllStart = new Date(dayStart.getTime() - hourMs);
      const activeAllEndExclusive = new Date(dayEndExclusive.getTime() + hourMs);
      const dineInActive: Record<string, unknown> = {
        type: 'dine_in',
        status: { $in: [...ACTIVE_ORDER_STATUSES] },
        /** 后结改单隐藏；先付下也不应出现在统一队列（与 /dine-in/active 对齐） */
        dineInExposedToStaff: { $ne: false },
      };
      const orders = await Order.find({
        storeId: req.storeId,
        createdAt: { $gte: activeAllStart, $lt: activeAllEndExclusive },
        $or: [
          { type: 'takeout', status: { $in: [...ACTIVE_ORDER_STATUSES] } },
          dineInActive,
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
      let totalAmount = Math.round((itemTotal - bundleDiscount) * 100) / 100;
      const wfDn = await getDineInWorkflowModeForStore(req.storeId!);
      if (wfDn === 'pay_after') {
        const priorCheckouts = await Checkout.find({ storeId: req.storeId, orderIds: order._id }).lean();
        let partialSum = 0;
        for (const c of priorCheckouts as { totalAmount?: number; dineInPartialLineSettlements?: unknown[] }[]) {
          if (Array.isArray(c.dineInPartialLineSettlements) && c.dineInPartialLineSettlements.length > 0) {
            partialSum += Number(c.totalAmount) || 0;
          }
        }
        totalAmount = Math.max(0, Math.round((totalAmount - partialSum) * 100) / 100);
      }

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

  // PUT /api/orders/:id/dine-in-exposed — 后结堂食：顾客改单前隐藏 / 保存后重新对店端展示（须置于 /:id 的 GET 之前）
  router.put('/:id/dine-in-exposed', optionalAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order } = orderModels();
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }
      const wf = await getDineInWorkflowModeForStore(req.storeId!);
      if (wf !== 'pay_after') {
        throw createAppError('VALIDATION_ERROR', '当前店铺未启用后结堂食流程');
      }
      const exposed = Boolean(req.body?.exposed);
      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }
      if (order.type !== 'dine_in') {
        throw createAppError('VALIDATION_ERROR', 'Only dine-in orders support this action');
      }
      if (!['pending', 'paid_online'].includes(String(order.status))) {
        throw createAppError('ORDER_NOT_MODIFIABLE', 'Order status does not allow visibility changes');
      }
      if (!exposed && order.dineInStaffLockedAt) {
        throw createAppError('ORDER_NOT_MODIFIABLE', '店员已锁定本单，无法再对店端隐藏');
      }
      order.dineInExposedToStaff = exposed;
      await order.save();
      io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/orders/:id/dine-in-staff-lock — 后结堂食：店员锁定（顾客仅可加菜）
  router.put(
    '/:id/dine-in-staff-lock',
    ...requireAuthSameStore,
    requirePermission('checkout:process'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { Order } = orderModels();
        const id = req.params.id as string;
        if (!mongoose.Types.ObjectId.isValid(id)) {
          throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
        }
        const wf = await getDineInWorkflowModeForStore(req.storeId!);
        if (wf !== 'pay_after') {
          throw createAppError('VALIDATION_ERROR', '当前店铺未启用后结堂食流程');
        }
        const order = await Order.findOne({ _id: id, storeId: req.storeId });
        if (!order) {
          throw createAppError('NOT_FOUND', 'Order not found');
        }
        if (order.type !== 'dine_in') {
          throw createAppError('VALIDATION_ERROR', 'Only dine-in orders can be locked');
        }
        if (order.status !== 'pending') {
          throw createAppError('ORDER_NOT_MODIFIABLE', 'Only pending dine-in orders can be locked', {
            currentStatus: order.status,
          });
        }
        order.dineInStaffLockedAt = new Date();
        order.dineInExposedToStaff = true;
        await order.save();
        io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);
        res.json(order);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/orders/:id/kitchen-printed-increment — 堂食厨房出单：按行累加已打印份数（后结增量打印成功后调用）
  router.post(
    '/:id/kitchen-printed-increment',
    ...requireAuthSameStore,
    requirePermission('checkout:process'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { Order } = orderModels();
        const id = req.params.id as string;
        if (!mongoose.Types.ObjectId.isValid(id)) {
          throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
        }
        const raw = (req.body as { increments?: unknown }).increments;
        if (!Array.isArray(raw) || raw.length === 0) {
          throw createAppError('VALIDATION_ERROR', 'increments must be a non-empty array');
        }
        const order = await Order.findOne({ _id: id, storeId: req.storeId });
        if (!order) {
          throw createAppError('NOT_FOUND', 'Order not found');
        }
        if (order.type !== 'dine_in') {
          throw createAppError('VALIDATION_ERROR', 'Only dine-in orders support kitchen print marks');
        }
        if (!['pending', 'paid_online', 'checked_out'].includes(String(order.status))) {
          throw createAppError('ORDER_NOT_MODIFIABLE', 'Order status does not allow kitchen print updates');
        }
        for (const row of raw) {
          const lineId =
            row && typeof row === 'object' && typeof (row as { lineId?: unknown }).lineId === 'string'
              ? (row as { lineId: string }).lineId
              : '';
          const qtyRaw = row && typeof row === 'object' ? (row as { qty?: unknown }).qty : undefined;
          const qty = typeof qtyRaw === 'number' && Number.isFinite(qtyRaw) ? qtyRaw : NaN;
          if (!mongoose.Types.ObjectId.isValid(lineId) || !(qty >= 1)) {
            throw createAppError('VALIDATION_ERROR', 'Each increment needs valid lineId and qty >= 1');
          }
          const line = order.items.id(lineId);
          if (!line) {
            throw createAppError('VALIDATION_ERROR', `Unknown line id: ${lineId}`);
          }
          if ((line as { lineKind?: string }).lineKind === 'delivery_fee') {
            throw createAppError('VALIDATION_ERROR', 'Cannot mark delivery_fee lines');
          }
          if ((line as { refunded?: boolean }).refunded) {
            throw createAppError('VALIDATION_ERROR', 'Cannot mark refunded lines');
          }
          const maxQ = typeof line.quantity === 'number' ? line.quantity : 0;
          const cur = Math.max(0, Math.min(Number((line as { kitchenPrintedQty?: number }).kitchenPrintedQty) || 0, maxQ));
          if (cur + qty > maxQ) {
            throw createAppError('VALIDATION_ERROR', 'kitchenPrintedQty would exceed line quantity', {
              lineId,
              current: cur,
              add: qty,
              max: maxQ,
            });
          }
          (line as { kitchenPrintedQty?: number }).kitchenPrintedQty = cur + qty;
        }
        await order.save();
        io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);
        res.json(order);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/orders/:id/kitchen-printed-all — 将该单所有菜品行标记为已全部打印
  router.post(
    '/:id/kitchen-printed-all',
    ...requireAuthSameStore,
    requirePermission('checkout:process'),
    async (req: Request, res: Response, next: NextFunction) => {
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
        if (order.type !== 'dine_in') {
          throw createAppError('VALIDATION_ERROR', 'Only dine-in orders support kitchen print marks');
        }
        if (!['pending', 'paid_online', 'checked_out'].includes(String(order.status))) {
          throw createAppError('ORDER_NOT_MODIFIABLE', 'Order status does not allow kitchen print updates');
        }
        for (const line of order.items) {
          const lk = (line as { lineKind?: string }).lineKind;
          if (lk === 'delivery_fee') continue;
          if ((line as { refunded?: boolean }).refunded) continue;
          const maxQ = typeof line.quantity === 'number' ? line.quantity : 0;
          (line as { kitchenPrintedQty?: number }).kitchenPrintedQty = maxQ;
        }
        await order.save();
        io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);
        res.json(order);
      } catch (err) {
        next(err);
      }
    },
  );

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
  router.put('/:id/items', optionalAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
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

      if (order.type === 'dine_in' && order.dineInStaffLockedAt) {
        const dineInWf = await getDineInWorkflowModeForStore(req.storeId!);
        if (dineInWf === 'pay_after' && !isStaffCashierOrOwner(req)) {
          assertDineInItemsAdditiveOnly(order.items, orderItems as Record<string, unknown>[]);
        }
      }

      if (order.type === 'dine_in') {
        mergeDineInKitchenPrintedAndSettledFromPrevious(
          order.items as Parameters<typeof mergeDineInKitchenPrintedAndSettledFromPrevious>[0],
          orderItems as Record<string, unknown>[],
        );
      }

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

      if (order.type === 'dine_in') {
        const lines = (order.items || []) as Array<{
          lineKind?: string;
          refunded?: boolean;
          quantity: number;
          kitchenPrintedQty?: number;
          settledQty?: number;
        }>;
        for (const it of lines) {
          if (it.lineKind === 'delivery_fee' || it.refunded) continue;
          if ((Number(it.kitchenPrintedQty) || 0) > 0) {
            throw createAppError(
              'ORDER_NOT_MODIFIABLE',
              'Cannot cancel dine-in order: kitchen ticket already printed',
              { reason: 'kitchen_printed' },
            );
          }
          if ((Number(it.settledQty) || 0) > 0) {
            throw createAppError(
              'ORDER_NOT_MODIFIABLE',
              'Cannot cancel dine-in order: partial payment already applied',
              { reason: 'settled_qty' },
            );
          }
        }
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

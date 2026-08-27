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
  parseDeliveryFeeEuroInput,
  parseDeliveryFeeRulesJson,
} from '../utils/deliveryFeeRules';
import { computeOrderPayableTotalEuro } from '../utils/orderPayableTotal';
import { optionalAuthMiddleware, requirePermission } from '../middleware/auth';
import { Role } from '../middleware/permissions';
import { requireAuthSameStore } from '../middleware/authForStore';
import { customerPhoneMatchCandidates, normalizeMemberPhone, debitMemberWallet } from '../utils/memberWalletOps';
import { resolveMemberPaymentForCheckout } from '../utils/checkoutMemberResolve';
import { attachCustomerProfileToDeliveryOrder } from '../utils/customerProfileDelivery';
import { aggregateFrequentMenuItemsForCustomer } from '../utils/customerFrequentOrderItems';
import { zonedDayBoundsForRef } from '../utils/zonedDayBounds';
import { getDineInWorkflowModeForStore } from '../utils/dineInWorkflowMode';
import { assertDineInItemsAdditiveOnly, mergeDineInKitchenPrintedAndSettledFromPrevious } from '../utils/dineInPayAfterItems';
import {
  adHocOptionsToSnapshots,
  parseAdHocOptionsFromItemPayload,
  type AdHocOptionInput,
} from '../utils/cashierAdHocOptions';
import {
  aggregateServingsByMenuItem,
  deductStockForOrderCreation,
  deductRawMaterialsForOrderCreation,
  deductRawMaterialsFromDemand,
  diffServings,
  diffRawMaterialDemand,
  writeSaleTxns,
  writeRawMaterialSaleTxns,
  type OrderItemForInventory,
} from '../utils/inventoryService';
import { voidNotifyCustomerOrderEvent } from '../modules/customer-notifications/dispatcher';
import { releaseNumberedVoucherForOrder } from '../utils/numberedVoucherOps';
import { handleNotifyCustomerReady } from './customerNotifications';
import {
  DUAL_TRACK_VERSION,
  fulfillmentAfterKitchenPrintAll,
  initialDualTrackForCreate,
  isCashierKitchenAtPlacement,
  isKitchenPrintSatisfied,
  isLegacyPaymentSettled,
  maybeAdvanceDeliveryStageOnKitchenReady,
  resolveTakeoutPlacementSource,
  syncDualTrackBeforeSave,
} from '../utils/orderDualTrack';
import {
  cashierMayEditQrOrder,
  isCustomerQrOrderForEdit,
} from '../utils/cashierQrOrderEdit';

const KITCHEN_PRINT_ORDER_TYPES = new Set(['dine_in', 'takeout', 'phone', 'delivery']);

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

/** pending 且未付：顾客可自助 DELETE；其余状态须收银/店主 */
function customerMaySelfCancelOrder(order: {
  status?: string;
  paymentStatus?: string;
  stripePaymentIntentId?: string;
  memberCreditUsed?: number;
  placementPrepaidMethod?: string;
  phoneCardPaidAtPlacement?: boolean;
}): boolean {
  const st = String(order.status || 'pending');
  if (st !== 'pending') return false;
  if (order.stripePaymentIntentId) return false;
  if (order.phoneCardPaidAtPlacement) return false;
  if (order.placementPrepaidMethod) return false;
  if ((Number(order.memberCreditUsed) || 0) > 0.001) return false;
  const ps = String(order.paymentStatus || 'unpaid');
  if (ps === 'paid' || ps === 'partial') return false;
  return true;
}

function orderModels() {
  return getModels() as {
    MenuItem: mongoose.Model<any>;
    Order: mongoose.Model<any>;
    Checkout: mongoose.Model<any>;
    DailyOrderCounter: mongoose.Model<any>;
    SystemConfig: mongoose.Model<any>;
    CustomerProfile: mongoose.Model<any>;
    InventoryTxn: mongoose.Model<any>;
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

  type OrderItemBuildInput = {
    menuItemId: string;
    quantity: number;
    selectedOptions?: SelectedOptInput[];
    adHocOptions?: AdHocOptionInput[];
  };

  function parseOrderItemAdHoc(raw: unknown, staffAllowed: boolean): AdHocOptionInput[] {
    const hasField = raw !== undefined && raw !== null && !(Array.isArray(raw) && raw.length === 0);
    if (!hasField) return [];
    if (!staffAllowed) {
      throw createAppError('FORBIDDEN', 'adHocOptions requires cashier or owner session');
    }
    const parsed = parseAdHocOptionsFromItemPayload(raw);
    if (parsed === null) {
      throw createAppError('VALIDATION_ERROR', 'Invalid adHocOptions on order item');
    }
    return parsed;
  }

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
    items: OrderItemBuildInput[],
    menuItemMap: Map<string, MenuItemForOrder>,
    staffAllowed: boolean,
  ) {
    const orderItems: {
      menuItemId?: string;
      lineKind?: string;
      quantity: number;
      unitPrice: number;
      itemName: string;
      itemNameEn: string;
      selectedOptions: {
        groupName: string;
        groupNameEn: string;
        choiceName: string;
        choiceNameEn: string;
        extraPrice: number;
        source?: string;
      }[];
    }[] = [];

    for (const item of items) {
      const menuItem = menuItemMap.get(item.menuItemId)!;
      const zhTrans = menuItem.translations?.find((t: { locale: string }) => t.locale === 'zh-CN');
      const enTrans = menuItem.translations?.find((t: { locale: string }) => t.locale === 'en-US');
      const itemName = zhTrans?.name || enTrans?.name || (menuItem.translations?.[0] as { name: string })?.name || 'Unknown';
      const itemNameEn = enTrans?.name || zhTrans?.name || itemName;
      const menuSnapshots = await snapshotSelectedOptionsFromMenuItem(storeId, menuItem, item.selectedOptions);
      const adHocSnapshots = adHocOptionsToSnapshots(parseOrderItemAdHoc(item.adHocOptions, staffAllowed));
      const selectedOptions = [
        ...menuSnapshots.map((s) => ({ ...s, source: 'menu' as const })),
        ...adHocSnapshots,
      ];

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

  // POST /api/orders — Create a new order（外卖收银点单须 body.staffTakeoutPlacement=true + 店员会话）
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
      const staffAllowed = isStaffCashierOrOwner(req);
      const waiterPlacement =
        staffAllowed &&
        ((req.body as { waiterPlacement?: unknown }).waiterPlacement === true ||
          (req.body as { waiterPlacement?: unknown }).waiterPlacement === 'true');
      const orderItems = await buildOrderItemsPayload(req.storeId!, items, menuItemMap, staffAllowed);
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
        if (dineInWf === 'pay_after' || waiterPlacement) {
          // 首次下单对店端可见；顾客点「改单」会先调 dine-in-exposed 隐藏
          // waiterPlacement：先付店也走未结，必须进订单中心
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

        let suggestedFee = 0;
        if (deliveryRules.length > 0) {
          if (dist === undefined) {
            throw createAppError(
              'VALIDATION_ERROR',
              '已配置距离阶梯送餐费：需提供 deliveryDistanceKm（公里，可由邮编解析）',
            );
          }
          suggestedFee = deliveryFeeForDistance(deliveryRules, dist);
        }

        let fee = suggestedFee;
        const rawFeeOverride = (req.body as { deliveryFeeEuroOverride?: unknown }).deliveryFeeEuroOverride;
        if (rawFeeOverride !== undefined && rawFeeOverride !== null && rawFeeOverride !== '') {
          const parsedOverride = parseDeliveryFeeEuroInput(rawFeeOverride);
          if (parsedOverride === null) {
            throw createAppError('VALIDATION_ERROR', 'deliveryFeeEuroOverride must be a non-negative number');
          }
          if (!isStaffCashierOrOwner(req)) {
            throw createAppError('FORBIDDEN', 'deliveryFeeEuroOverride requires cashier or owner session');
          }
          fee = parsedOverride;
        }

        if (dist !== undefined) orderData.deliveryDistanceKm = dist;
        orderData.deliveryFeeEuro = fee;
        if (deliveryRules.length > 0 && dist !== undefined) {
          orderData.suggestedDeliveryFeeEuro = suggestedFee;
        }
        appendDeliveryFeeLineToOrderItems(orderItems as Record<string, unknown>[], type, fee);

        /** 关联/创建 CustomerProfile：仅在订单落库时执行，不在未下单时建档 */
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
        const rawStaffTakeout = (req.body as { staffTakeoutPlacement?: unknown }).staffTakeoutPlacement;
        const placementSource = resolveTakeoutPlacementSource({
          staffTakeoutPlacement: rawStaffTakeout,
          isStaffCashier: isStaffCashierOrOwner(req),
        });
        const isCashierPlacement = placementSource === 'cashier';
        orderData.takeoutPlacementSource = placementSource;

        const name = typeof customerName === 'string' ? customerName.trim() : '';
        const rawPhone = typeof customerPhone === 'string' ? customerPhone.trim() : '';
        if (!isCashierPlacement && !rawPhone) {
          throw createAppError(
            'VALIDATION_ERROR',
            'takeout orders require customerPhone',
          );
        }
        if (name) {
          orderData.customerName = name;
        }
        if (rawPhone) {
          const normPhone = normalizeMemberPhone(rawPhone);
          orderData.customerPhone =
            normPhone.length >= 8 ? normPhone : rawPhone.replace(/\D/g, '') || rawPhone;
        }
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

      const rawPhoneCard = (req.body as { phoneCardPaidAtPlacement?: unknown }).phoneCardPaidAtPlacement;
      const wantsPhoneCard = rawPhoneCard === true || rawPhoneCard === 'true';
      const rawPlacementMethod = (req.body as { placementPrepaidMethod?: unknown }).placementPrepaidMethod;
      const placementMethod =
        rawPlacementMethod === 'card' || rawPlacementMethod === 'member' ? rawPlacementMethod : null;
      let prepaidAtPlacement = false;
      if ((wantsPhoneCard || placementMethod) && !waiterPlacement) {
        if (!isStaffCashierOrOwner(req)) {
          throw createAppError('FORBIDDEN', 'placementPrepaidMethod requires cashier or owner session');
        }
        const ds = String((orderData as { deliverySource?: string }).deliverySource || '');
        const isPhonePlacement = type === 'phone' || (type === 'delivery' && ds === 'phone');
        if (!isPhonePlacement) {
          throw createAppError(
            'VALIDATION_ERROR',
            'placementPrepaidMethod is only allowed for phone orders or delivery with deliverySource=phone',
          );
        }
        const method = placementMethod || (wantsPhoneCard ? 'card' : null);
        if (method !== 'card' && method !== 'member') {
          throw createAppError('VALIDATION_ERROR', 'placementPrepaidMethod must be "card" or "member"');
        }
        orderData.status = 'paid_online';
        orderData.placementPrepaidMethod = method;
        if (method === 'card') {
          orderData.phoneCardPaidAtPlacement = true;
        }
        if (method === 'member') {
          const memberPhoneRaw = typeof (req.body as { memberPhone?: unknown }).memberPhone === 'string'
            ? String((req.body as { memberPhone: string }).memberPhone).trim()
            : '';
          if (!memberPhoneRaw) {
            throw createAppError('VALIDATION_ERROR', 'memberPhone is required for placementPrepaidMethod=member');
          }
          const features = await resolveStoreEffectiveFeatures(req.storeId!);
          if (!features.has(FeatureKeys.CashierMemberWallet)) {
            throw createAppError('FORBIDDEN', '当前套餐未开通会员储值');
          }
        }
        prepaidAtPlacement = true;
      }

      const takeoutSrc = (orderData as { takeoutPlacementSource?: string }).takeoutPlacementSource;
      const deliverySrcRaw = String((orderData as { deliverySource?: string }).deliverySource || '').trim();
      const deliverySrc = type === 'delivery' ? (deliverySrcRaw === 'qr' ? 'qr' : 'phone') : undefined;
      const kitchenAtPlacement = isCashierKitchenAtPlacement({
        type,
        takeoutPlacementSource: takeoutSrc === 'cashier' ? 'cashier' : takeoutSrc === 'customer' ? 'customer' : undefined,
        deliverySource: deliverySrc,
        waiterPlacement,
      });
      if (kitchenAtPlacement) {
        for (const line of orderItems as { lineKind?: string; kitchenPrintedQty?: number; quantity: number }[]) {
          if (line.lineKind === 'delivery_fee') continue;
          line.kitchenPrintedQty = line.quantity;
        }
        if (type === 'delivery' && deliverySrc === 'phone') {
          orderData.deliveryStage = 'accepted';
        }
      }
      Object.assign(
        orderData,
        initialDualTrackForCreate({
          type,
          takeoutPlacementSource: takeoutSrc === 'cashier' ? 'cashier' : takeoutSrc === 'customer' ? 'customer' : undefined,
          deliverySource: deliverySrc,
          prepaidAtPlacement,
          waiterPlacement,
        }),
      );

      /** 库存追踪：在订单写入前先做原子扣减；后续任何抛错都要把扣减回滚 */
      const inventoryServings = aggregateServingsByMenuItem(
        items as OrderItemForInventory[],
      );
      const inventoryDeduction = await deductStockForOrderCreation(
        req.storeId!,
        inventoryServings,
        menuItems as unknown as Parameters<typeof deductStockForOrderCreation>[2],
      );

      /** B 模式（原材料 BoM）扣减：用已解析选项快照的 orderItems，与改单路径一致 */
      const bomLinesForDeduction = orderItems
        .filter((oi) => oi.lineKind !== 'delivery_fee')
        .map((oi) => ({
          menuItemId: oi.menuItemId,
          quantity: oi.quantity,
          lineKind: oi.lineKind,
          selectedOptions: (oi.selectedOptions || [])
            .filter((s) => (s as { source?: string }).source !== 'adHoc')
            .map((s) => ({
              groupName: s.groupName,
              choiceName: s.choiceName,
            })),
        }));
      let rawDeduction: Awaited<ReturnType<typeof deductRawMaterialsForOrderCreation>>
        = { demand: new Map(), snapshots: new Map() };
      try {
        rawDeduction = await deductRawMaterialsForOrderCreation(
          req.storeId!,
          bomLinesForDeduction as unknown as Parameters<typeof deductRawMaterialsForOrderCreation>[1],
          menuItems as unknown as Parameters<typeof deductRawMaterialsForOrderCreation>[2],
        );
      } catch (rawErr) {
        if (inventoryDeduction.demands.length > 0) {
          const { MenuItem: MI } = orderModels();
          for (const d of inventoryDeduction.demands) {
            try {
              await MI.updateOne(
                { _id: d.menuItemId, storeId: req.storeId },
                { $inc: { 'inventory.currentQty': d.baseQty } },
              );
            } catch { /* best-effort rollback */ }
          }
        }
        throw rawErr;
      }

      let order: any;
      try {
        order = await Order.create(orderData);

        const placementMember =
          (order as { placementPrepaidMethod?: string }).placementPrepaidMethod === 'member';
        if (placementMember) {
          const { Member, MemberWalletTxn } = getModels() as {
            Member: mongoose.Model<unknown>;
            MemberWalletTxn: mongoose.Model<unknown>;
          };
          const totalAmount = computeOrderPayableTotalEuro(order);
          const memberPhone = String((req.body as { memberPhone?: string }).memberPhone || '').trim();
          const mp = await resolveMemberPaymentForCheckout({
            storeId: req.storeId!,
            Member,
            finalAmount: totalAmount,
            body: { memberPhone, paymentMethod: 'member' },
            skipMemberPin: true,
          });
          if (mp.paymentMethod !== 'member' || mp.memberCreditUsed + 0.02 < totalAmount) {
            throw createAppError('VALIDATION_ERROR', '会员余额不足以支付本单');
          }
          await debitMemberWallet({
            Member,
            MemberWalletTxn,
            storeId: req.storeId!,
            memberId: mp.memberId!,
            amountEuro: mp.memberCreditUsed,
            orderId: order._id as mongoose.Types.ObjectId,
            note: '电话单下单时已付（会员储值）',
          });
          order.memberId = mp.memberId;
          order.memberCreditUsed = mp.memberCreditUsed;
          order.memberPhoneSnapshot = mp.memberPhoneSnapshot;
          order.paymentStatus = 'paid';
          syncDualTrackBeforeSave(order);
          await order.save();
        }
      } catch (writeErr) {
        if (inventoryDeduction.demands.length > 0) {
          const { MenuItem: MI } = orderModels();
          for (const d of inventoryDeduction.demands) {
            try {
              await MI.updateOne(
                { _id: d.menuItemId, storeId: req.storeId },
                { $inc: { 'inventory.currentQty': d.baseQty } },
              );
            } catch {
              /* best-effort rollback */
            }
          }
        }
        if (rawDeduction.demand.size > 0) {
          const { RawMaterial: RM } = getModels() as { RawMaterial: mongoose.Model<any> };
          for (const [rid, qty] of rawDeduction.demand) {
            try {
              await RM.updateOne(
                { _id: rid, storeId: req.storeId },
                { $inc: { currentQty: qty } },
              );
            } catch { /* best-effort */ }
          }
        }
        throw writeErr;
      }

      if (inventoryDeduction.demands.length > 0) {
        void writeSaleTxns(
          req.storeId!,
          order._id as mongoose.Types.ObjectId,
          inventoryDeduction.demands,
          inventoryDeduction.snapshots,
        );
      }
      if (rawDeduction.demand.size > 0) {
        void writeRawMaterialSaleTxns(
          req.storeId!,
          order._id as mongoose.Types.ObjectId,
          rawDeduction.demand,
          rawDeduction.snapshots,
        );
      }

      io.to(storeIoRoom(req.storeId!)).emit('order:new', order);

      const orderLean = typeof order.toObject === 'function' ? order.toObject() : order;
      voidNotifyCustomerOrderEvent({
        storeId: req.storeId!,
        order: orderLean,
        event: 'order_placed',
      });
      if ((orderLean as { phoneCardPaidAtPlacement?: boolean }).phoneCardPaidAtPlacement
        || (orderLean as { placementPrepaidMethod?: string }).placementPrepaidMethod) {
        voidNotifyCustomerOrderEvent({
          storeId: req.storeId!,
          order: orderLean,
          event: 'payment_confirmed',
        });
      }

      /** 给收银本地缓存做就地 patch：返回订单同时附带本次扣减后的最新库存快照 */
      const inventoryUpdates = inventoryDeduction.demands.length === 0
        ? []
        : inventoryDeduction.demands.map((d) => {
            const snap = inventoryDeduction.snapshots.get(d.menuItemId);
            return {
              menuItemId: d.menuItemId,
              currentQty: snap?.qtyAfter ?? 0,
              perServing: d.perServing,
              baseUnit: d.baseUnit,
            };
          });
      const responseBody: Record<string, unknown> = {
        ...(typeof order.toObject === 'function' ? order.toObject() : order),
      };
      if (inventoryUpdates.length > 0) responseBody.inventoryUpdates = inventoryUpdates;
      res.status(201).json(responseBody);
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
      const orders = await Order.find({
        storeId: req.storeId,
        type: 'phone',
        $or: [{ status: 'pending' }, { status: 'paid_online', phoneCardPaidAtPlacement: true }],
      }).sort({ dailyOrderNumber: 1 });
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
            $or: [
              { status: 'pending' },
              { status: 'paid_online', phoneCardPaidAtPlacement: true },
              { status: 'paid_online', placementPrepaidMethod: { $in: ['card', 'member'] } },
            ],
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
          // Dual-track: fulfilled but unpaid must stay active until payment.
          {
            dualTrackVersion: DUAL_TRACK_VERSION,
            fulfillmentStatus: 'fulfilled',
            paymentStatus: { $in: ['unpaid', 'partial'] },
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

      order.status = 'completed';
      order.completedAt = new Date();
      syncDualTrackBeforeSave(order);
      await order.save();
      res.json(order);
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

      order.status = 'completed';
      order.completedAt = new Date();
      syncDualTrackBeforeSave(order);
      await order.save();
      io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);
      res.json(order);
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

      order.status = 'completed';
      order.completedAt = new Date();
      const wfDnComplete = await getDineInWorkflowModeForStore(req.storeId!);
      syncDualTrackBeforeSave(order, { dineInWorkflowMode: wfDnComplete });
      await order.save();

      io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/orders/phone/:id/complete-placement-card-paid
  // Placement-time prepaid (card/member): create Checkout if missing, then mark completed after kitchen + pickup.
  router.put('/phone/:id/complete-placement-card-paid', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order, Checkout } = getModels() as {
        Order: mongoose.Model<any>;
        Checkout: mongoose.Model<any>;
      };
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }

      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }
      if (order.type !== 'phone') {
        throw createAppError('VALIDATION_ERROR', 'Only phone orders can use this action');
      }
      const prepaid =
        order.phoneCardPaidAtPlacement
        || order.placementPrepaidMethod === 'card'
        || order.placementPrepaidMethod === 'member';
      if (!prepaid) {
        throw createAppError('VALIDATION_ERROR', 'Order was not created with placement prepayment', {
          currentStatus: order.status,
        });
      }
      if (order.status !== 'paid_online') {
        throw createAppError('VALIDATION_ERROR', 'Only paid_online phone orders can be finished here', {
          currentStatus: order.status,
        });
      }

      let checkout = await Checkout.findOne({ storeId: req.storeId, orderIds: order._id }).sort({ checkedOutAt: 1 });
      if (!checkout) {
        const totalAmount = computeOrderPayableTotalEuro(order);
        const method = order.placementPrepaidMethod === 'member' ? 'member' : 'card';
        const checkoutPayload: Record<string, unknown> = {
          storeId: req.storeId,
          type: 'seat',
          totalAmount,
          paymentMethod: method,
          orderIds: [order._id],
        };
        if (method === 'card') {
          checkoutPayload.cardAmount = totalAmount;
        } else {
          checkoutPayload.memberId = order.memberId;
          checkoutPayload.memberPhoneSnapshot = String(order.memberPhoneSnapshot || '');
          checkoutPayload.memberCreditUsed = Number(order.memberCreditUsed) || totalAmount;
        }
        checkout = await Checkout.create(checkoutPayload);
      }

      order.status = 'completed';
      order.completedAt = new Date();
      syncDualTrackBeforeSave(order);
      await order.save();

      io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);
      voidNotifyCustomerOrderEvent({
        storeId: req.storeId!,
        order,
        event: 'order_completed',
      });
      res.json(order);
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
      if (nextStage === 'picked_up_by_driver') {
        if (!isKitchenPrintSatisfied(order)) {
          throw createAppError('VALIDATION_ERROR', '须先送厨房制作后再安排司机取餐');
        }
        const curStage = String(order.deliveryStage || 'new').trim() || 'new';
        if (curStage !== 'accepted' && curStage !== 'new') {
          throw createAppError('VALIDATION_ERROR', '订单须为已接单状态后才能标记司机取走');
        }
      }
      order.deliveryStage = nextStage;
      if (nextStage === 'picked_up_by_driver') {
        const paymentSettled =
          isLegacyPaymentSettled(String(order.status))
          || String(order.paymentStatus) === 'paid';
        if (paymentSettled) {
          order.status = 'completed';
          order.completedAt = new Date();
        }
      }
      syncDualTrackBeforeSave(order);
      await order.save();
      io.to(storeIoRoom(req.storeId!)).emit('order:updated', order);
      const orderLean = typeof order.toObject === 'function' ? order.toObject() : order;
      if (nextStage === 'out_for_delivery') {
        voidNotifyCustomerOrderEvent({
          storeId: req.storeId!,
          order: orderLean,
          event: 'out_for_delivery',
        });
      }
      if (nextStage === 'picked_up_by_driver' && order.status === 'completed') {
        voidNotifyCustomerOrderEvent({
          storeId: req.storeId!,
          order: orderLean,
          event: 'order_completed',
        });
      }
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/orders/:id/notify-customer-ready — cashier triggers ready notification
  router.post(
    '/:id/notify-customer-ready',
    ...requireAuthSameStore,
    requirePermission('checkout:process'),
    handleNotifyCustomerReady,
  );

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
        if (!KITCHEN_PRINT_ORDER_TYPES.has(String(order.type))) {
          throw createAppError('VALIDATION_ERROR', 'This order type does not support kitchen print marks');
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
        if (Number(order.dualTrackVersion) === DUAL_TRACK_VERSION) {
          order.fulfillmentStatus = fulfillmentAfterKitchenPrintAll(order.fulfillmentStatus);
        }
        if (isKitchenPrintSatisfied(order)) {
          maybeAdvanceDeliveryStageOnKitchenReady(order);
        }
        order.markModified('items');
        const wfKitchen = order.type === 'dine_in' ? await getDineInWorkflowModeForStore(req.storeId!) : undefined;
        syncDualTrackBeforeSave(order, { dineInWorkflowMode: wfKitchen });
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
        if (!KITCHEN_PRINT_ORDER_TYPES.has(String(order.type))) {
          throw createAppError('VALIDATION_ERROR', 'This order type does not support kitchen print marks');
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
        if (Number(order.dualTrackVersion) === DUAL_TRACK_VERSION) {
          order.fulfillmentStatus = fulfillmentAfterKitchenPrintAll(order.fulfillmentStatus);
        }
        maybeAdvanceDeliveryStageOnKitchenReady(order);
        order.markModified('items');
        const wfKitchenAll = order.type === 'dine_in' ? await getDineInWorkflowModeForStore(req.storeId!) : undefined;
        syncDualTrackBeforeSave(order, { dineInWorkflowMode: wfKitchenAll });
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

      const staffAllowed = isStaffCashierOrOwner(req);
      if (staffAllowed && isCustomerQrOrderForEdit(order)) {
        const dineInWf = await getDineInWorkflowModeForStore(req.storeId!);
        if (!cashierMayEditQrOrder(order, dineInWf)) {
          throw createAppError(
            'ORDER_NOT_MODIFIABLE',
            'Only pending unpaid QR orders not yet sent to kitchen can be edited by staff',
          );
        }
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
      const orderItems = await buildOrderItemsPayload(req.storeId!, items, menuItemMap, staffAllowed);
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

      /** 库存追踪：仅对新增加的份数做扣减（同 menuItemId 的累计差额） */
      const deltaServings = diffServings(
        order.items as OrderItemForInventory[],
        orderItems as unknown as OrderItemForInventory[],
      );
      const inventoryDelta = await deductStockForOrderCreation(
        req.storeId!,
        deltaServings,
        menuItems as unknown as Parameters<typeof deductStockForOrderCreation>[2],
      );

      /** B 模式增量扣减：先算 BoM 差额，再走原子扣减；失败回滚 A 模式扣减 */
      const rawDemandDelta = diffRawMaterialDemand(
        order.items as unknown as Parameters<typeof diffRawMaterialDemand>[0],
        orderItems as unknown as Parameters<typeof diffRawMaterialDemand>[1],
        menuItems as unknown as Parameters<typeof diffRawMaterialDemand>[2],
      );
      let rawDelta: Awaited<ReturnType<typeof deductRawMaterialsFromDemand>>
        = { demand: new Map(), snapshots: new Map() };
      try {
        rawDelta = await deductRawMaterialsFromDemand(req.storeId!, rawDemandDelta);
      } catch (rawErr) {
        for (const d of inventoryDelta.demands) {
          try {
            const { MenuItem: MI } = orderModels();
            await MI.updateOne(
              { _id: d.menuItemId, storeId: req.storeId },
              { $inc: { 'inventory.currentQty': d.baseQty } },
            );
          } catch { /* best-effort */ }
        }
        throw rawErr;
      }

      let updated: any;
      try {
        updated = await Order.findOneAndUpdate(
          { _id: id, storeId: req.storeId },
          { $set: { items: orderItems } },
          { new: true },
        );
      } catch (writeErr) {
        for (const d of inventoryDelta.demands) {
          try {
            const { MenuItem: MI } = orderModels();
            await MI.updateOne(
              { _id: d.menuItemId, storeId: req.storeId },
              { $inc: { 'inventory.currentQty': d.baseQty } },
            );
          } catch {
            /* best-effort */
          }
        }
        if (rawDelta.demand.size > 0) {
          const { RawMaterial: RM } = getModels() as { RawMaterial: mongoose.Model<any> };
          for (const [rid, qty] of rawDelta.demand) {
            try {
              await RM.updateOne(
                { _id: rid, storeId: req.storeId },
                { $inc: { currentQty: qty } },
              );
            } catch { /* best-effort */ }
          }
        }
        throw writeErr;
      }

      if (inventoryDelta.demands.length > 0) {
        void writeSaleTxns(
          req.storeId!,
          order._id as mongoose.Types.ObjectId,
          inventoryDelta.demands,
          inventoryDelta.snapshots,
        );
      }
      if (rawDelta.demand.size > 0) {
        void writeRawMaterialSaleTxns(
          req.storeId!,
          order._id as mongoose.Types.ObjectId,
          rawDelta.demand,
          rawDelta.snapshots,
        );
      }

      io.to(storeIoRoom(req.storeId!)).emit('order:updated', updated);

      /** 同 POST：返回本次新增扣减后的最新库存，给前端就地 patch */
      const inventoryUpdates = inventoryDelta.demands.length === 0
        ? []
        : inventoryDelta.demands.map((d) => {
            const snap = inventoryDelta.snapshots.get(d.menuItemId);
            return {
              menuItemId: d.menuItemId,
              currentQty: snap?.qtyAfter ?? 0,
              perServing: d.perServing,
              baseUnit: d.baseUnit,
            };
          });
      const responseBody: Record<string, unknown> = {
        ...(updated && typeof (updated as { toObject?: () => unknown }).toObject === 'function'
          ? ((updated as { toObject: () => Record<string, unknown> }).toObject())
          : (updated as unknown as Record<string, unknown>)),
      };
      if (inventoryUpdates.length > 0) responseBody.inventoryUpdates = inventoryUpdates;
      res.json(responseBody);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/orders/:id — Hard-delete order (+ linked checkouts). Staff any stage; customer pending unpaid only.
  router.delete('/:id', optionalAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Order, Checkout } = orderModels();
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw createAppError('VALIDATION_ERROR', 'Invalid order ID');
      }

      const order = await Order.findOne({ _id: id, storeId: req.storeId });
      if (!order) {
        throw createAppError('NOT_FOUND', 'Order not found');
      }

      if (!customerMaySelfCancelOrder(order) && !isStaffCashierOrOwner(req)) {
        throw createAppError(
          'FORBIDDEN',
          'Only staff can cancel orders that have been paid or are no longer pending',
        );
      }

      const orderLean = typeof order.toObject === 'function' ? order.toObject() : order;
      voidNotifyCustomerOrderEvent({
        storeId: req.storeId!,
        order: orderLean,
        event: 'order_cancelled',
      });

      await releaseNumberedVoucherForOrder(req.storeId!, order._id);
      await Checkout.deleteMany({ storeId: req.storeId, orderIds: order._id });
      await Order.findOneAndDelete({ _id: id, storeId: req.storeId });

      io.to(storeIoRoom(req.storeId!)).emit('order:cancelled', { orderId: id, tableNumber: order.tableNumber });

      res.json({ message: 'Order cancelled successfully' });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/orders/:id/toggle-hide — Toggle hide status (cash / member orders in admin history)
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

import mongoose from 'mongoose';

const StaffBalanceSchema = new mongoose.Schema(
  {
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
    creditBalance: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/** 平台会员：一个手机号一份客人钱包；员工按店分户额度。 */
export const PlatformMemberSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, trim: true },
    memberNo: { type: Number, unique: true, sparse: true },
    displayName: { type: String, default: '', trim: true },
    deliveryAddress: { type: String, default: '', trim: true },
    postalCode: { type: String, default: '', trim: true },
    creditBalance: { type: Number, default: 0, min: 0 },
    /** 客人印花（与钱包分开；满点自动兑钱包） */
    stampCount: { type: Number, default: 0, min: 0 },
    walletVersion: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'frozen'], default: 'active' },
    pinHash: { type: String, default: '' },
    pinFailedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    staffStoreIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Store' }],
    staffBalances: { type: [StaffBalanceSchema], default: [] },
    /** Apple Wallet PassKit authenticationToken（签发/更新卡时生成，勿泄露） */
    appleWalletAuthToken: { type: String, default: '', trim: true },
    /** 余额等变更时间，供 PassKit passesUpdatedSince / If-Modified-Since */
    appleWalletUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

PlatformMemberSchema.index({ displayName: 1 });
PlatformMemberSchema.index({ staffStoreIds: 1 });

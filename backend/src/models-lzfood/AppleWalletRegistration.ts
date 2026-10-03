import mongoose from 'mongoose';

/** Apple Wallet 设备注册（PassKit web service） */
export const AppleWalletRegistrationSchema = new mongoose.Schema(
  {
    deviceLibraryIdentifier: { type: String, required: true, trim: true },
    pushToken: { type: String, required: true, trim: true },
    passTypeIdentifier: { type: String, required: true, trim: true },
    serialNumber: { type: String, required: true, trim: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformMember', required: true, index: true },
  },
  { timestamps: true },
);

AppleWalletRegistrationSchema.index(
  { deviceLibraryIdentifier: 1, passTypeIdentifier: 1, serialNumber: 1 },
  { unique: true },
);
AppleWalletRegistrationSchema.index({ serialNumber: 1, passTypeIdentifier: 1 });
AppleWalletRegistrationSchema.index({ pushToken: 1 });

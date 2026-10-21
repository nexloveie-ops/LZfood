import mongoose from 'mongoose';

const AdminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['owner', 'cashier', 'purchasing'], required: true },
}, { timestamps: true });

export { AdminSchema };

import mongoose from 'mongoose';

const MenuTranslationSchema = new mongoose.Schema({
  locale: { type: String, required: true },
  name: { type: String, required: true },
}, { _id: false });

const MenuScheduleWindowSchema = new mongoose.Schema({
  /** 0=Sun … 6=Sat（Europe/Dublin）。空数组 = 每天 */
  days: { type: [Number], default: [] },
  start: { type: String, default: '00:00' },
  end: { type: String, default: '00:00' },
}, { _id: false });

/**
 * 店内多份菜单。分类 / 菜品 / 套餐挂在 menuId 下，内容互相独立。
 * channels 为空 = 不挂任何场景；未挂场景的方式回落到 isDefault 菜单。
 * sortOrder 越小优先级越高（列表越靠上）。
 */
const MenuSchema = new mongoose.Schema({
  translations: { type: [MenuTranslationSchema], default: [] },
  channels: [{
    type: String,
    enum: ['dine_in', 'takeout', 'phone', 'delivery'],
  }],
  schedule: { type: [MenuScheduleWindowSchema], default: [] },
  sortOrder: { type: Number, default: 0, index: true },
  isDefault: { type: Boolean, default: false, index: true },
}, { timestamps: true });

export { MenuSchema, MenuTranslationSchema, MenuScheduleWindowSchema };

import mongoose from 'mongoose';
import { Admin, MenuCategory, MenuItem, Order, Checkout, SystemConfig, DailyOrderCounter } from './index';

describe('Mongoose Data Models', () => {
  describe('Admin', () => {
    it('should have correct collection name', () => {
      expect(Admin.collection.collectionName).toBe('admins');
    });

    it('should require username, passwordHash, and role', () => {
      const doc = new Admin({});
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['username']).toBeDefined();
      expect(err!.errors['passwordHash']).toBeDefined();
      expect(err!.errors['role']).toBeDefined();
    });

    it('should only accept owner or cashier as role', () => {
      const doc = new Admin({ username: 'test', passwordHash: 'hash', role: 'invalid' });
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['role']).toBeDefined();
    });

    it('should accept valid admin data', () => {
      const doc = new Admin({ username: 'admin1', passwordHash: 'hash123', role: 'owner' });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
    });

    it('should have timestamps enabled', () => {
      const schema = Admin.schema;
      expect(schema.get('timestamps')).toBe(true);
    });
  });

  describe('MenuCategory', () => {
    it('should have correct collection name', () => {
      expect(MenuCategory.collection.collectionName).toBe('menu_categories');
    });

    it('should require sortOrder', () => {
      const doc = new MenuCategory({});
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['sortOrder']).toBeDefined();
    });

    it('should accept valid category with translations', () => {
      const doc = new MenuCategory({
        sortOrder: 1,
        translations: [
          { locale: 'zh-CN', name: '主食' },
          { locale: 'en-US', name: 'Main Course' },
        ],
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
    });

    it('should have timestamps enabled', () => {
      expect(MenuCategory.schema.get('timestamps')).toBe(true);
    });
  });

  describe('MenuItem', () => {
    it('should have correct collection name', () => {
      expect(MenuItem.collection.collectionName).toBe('menu_items');
    });

    it('should require categoryId and price', () => {
      const doc = new MenuItem({});
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['categoryId']).toBeDefined();
      expect(err!.errors['price']).toBeDefined();
    });

    it('should default isSoldOut to false', () => {
      const doc = new MenuItem({
        categoryId: new mongoose.Types.ObjectId(),
        price: 10,
      });
      expect(doc.isSoldOut).toBe(false);
    });

    it('should accept valid menu item with translations', () => {
      const doc = new MenuItem({
        categoryId: new mongoose.Types.ObjectId(),
        price: 25.5,
        calories: 350,
        avgWaitMinutes: 15,
        translations: [
          { locale: 'zh-CN', name: '宫保鸡丁', description: '经典川菜' },
          { locale: 'en-US', name: 'Kung Pao Chicken', description: 'Classic Sichuan dish' },
        ],
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
    });

    it('should have timestamps enabled', () => {
      expect(MenuItem.schema.get('timestamps')).toBe(true);
    });
  });

  describe('Order', () => {
    it('should have correct collection name', () => {
      expect(Order.collection.collectionName).toBe('orders');
    });

    it('should require type', () => {
      const doc = new Order({});
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['type']).toBeDefined();
    });

    it('should only accept dine_in or takeout as type', () => {
      const doc = new Order({ type: 'delivery' });
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['type']).toBeDefined();
    });

    it('should default status to pending', () => {
      const doc = new Order({ type: 'dine_in' });
      expect(doc.status).toBe('pending');
    });

    it('should validate item quantity min 1', () => {
      const doc = new Order({
        type: 'dine_in',
        items: [{ menuItemId: new mongoose.Types.ObjectId(), quantity: 0, unitPrice: 10, itemName: 'Test' }],
      });
      const err = doc.validateSync();
      expect(err).toBeDefined();
    });

    it('should accept valid dine-in order', () => {
      const doc = new Order({
        type: 'dine_in',
        tableNumber: 5,
        seatNumber: 2,
        items: [
          { menuItemId: new mongoose.Types.ObjectId(), quantity: 2, unitPrice: 15, itemName: '宫保鸡丁' },
        ],
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
    });

    it('should accept valid takeout order', () => {
      const doc = new Order({
        type: 'takeout',
        dailyOrderNumber: 1,
        items: [
          { menuItemId: new mongoose.Types.ObjectId(), quantity: 1, unitPrice: 20, itemName: 'Fried Rice' },
        ],
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
    });

    it('should have timestamps enabled', () => {
      expect(Order.schema.get('timestamps')).toBe(true);
    });
  });

  describe('Checkout', () => {
    it('should have correct collection name', () => {
      expect(Checkout.collection.collectionName).toBe('checkouts');
    });

    it('should require type, totalAmount, and paymentMethod', () => {
      const doc = new Checkout({});
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['type']).toBeDefined();
      expect(err!.errors['totalAmount']).toBeDefined();
      expect(err!.errors['paymentMethod']).toBeDefined();
    });

    it('should only accept table or seat as type', () => {
      const doc = new Checkout({ type: 'invalid', totalAmount: 100, paymentMethod: 'cash' });
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['type']).toBeDefined();
    });

    it('should accept tap_pay as paymentMethod', () => {
      const doc = new Checkout({
        type: 'seat',
        totalAmount: 20,
        paymentMethod: 'tap_pay',
      });
      expect(doc.validateSync()).toBeUndefined();
    });

    it('should only accept cash, card, or mixed as paymentMethod', () => {
      const doc = new Checkout({ type: 'table', totalAmount: 100, paymentMethod: 'bitcoin' });
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['paymentMethod']).toBeDefined();
    });

    it('should accept valid checkout data', () => {
      const doc = new Checkout({
        type: 'table',
        tableNumber: 3,
        totalAmount: 150,
        paymentMethod: 'mixed',
        cashAmount: 50,
        cardAmount: 100,
        orderIds: [new mongoose.Types.ObjectId()],
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
    });

    it('should default checkedOutAt to now', () => {
      const doc = new Checkout({
        type: 'seat',
        totalAmount: 50,
        paymentMethod: 'card',
      });
      expect(doc.checkedOutAt).toBeDefined();
    });
  });

  describe('SystemConfig', () => {
    it('should have correct collection name', () => {
      expect(SystemConfig.collection.collectionName).toBe('system_configs');
    });

    it('should require key and value', () => {
      const doc = new SystemConfig({});
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['key']).toBeDefined();
      expect(err!.errors['value']).toBeDefined();
    });

    it('should accept valid config data', () => {
      const doc = new SystemConfig({ key: 'receipt_print_copies', value: '2' });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
    });

    it('should have timestamps enabled', () => {
      expect(SystemConfig.schema.get('timestamps')).toBe(true);
    });
  });

  describe('DailyOrderCounter', () => {
    it('should have correct collection name', () => {
      expect(DailyOrderCounter.collection.collectionName).toBe('daily_order_counters');
    });

    it('should require date', () => {
      const doc = new DailyOrderCounter({});
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['date']).toBeDefined();
    });

    it('should default currentNumber to 0', () => {
      const doc = new DailyOrderCounter({ date: '2024-01-15' });
      expect(doc.currentNumber).toBe(0);
    });

    it('should accept valid counter data', () => {
      const doc = new DailyOrderCounter({ date: '2024-01-15', currentNumber: 5 });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
    });
  });
});

import mongoose from 'mongoose';
import {
  buildBomAvailabilitySnapshot,
  canSatisfyDemand,
  computeCartRawDemand,
  demandForOneServing,
  isItemServingBlocked,
  mergeDemandMaps,
} from './bomAvailability';

describe('bomAvailability', () => {
  const rid = new mongoose.Types.ObjectId().toString();
  const choiceId = new mongoose.Types.ObjectId().toString();
  const itemId = new mongoose.Types.ObjectId().toString();

  it('buildBomAvailabilitySnapshot collects item and choice consumption', () => {
    const snap = buildBomAvailabilitySnapshot(
      [{
        _id: new mongoose.Types.ObjectId(itemId),
        consumption: [{ rawMaterialId: rid, qty: 0.25 }],
        optionGroups: [{
          choices: [{
            _id: new mongoose.Types.ObjectId(choiceId),
            consumption: [{ rawMaterialId: rid, qty: 0.25 }],
          }],
        }],
      }],
      [{ _id: new mongoose.Types.ObjectId(rid), currentQty: 0.3, baseUnit: 'pcs', enabled: true }],
    );
    expect(snap.enabled).toBe(true);
    expect(snap.materials[rid].currentQty).toBe(0.3);
    expect(snap.items[itemId].itemConsumption).toHaveLength(1);
    expect(snap.items[itemId].choices[choiceId]).toHaveLength(1);
  });

  it('isItemServingBlocked when item BoM exceeds stock', () => {
    const itemBom = {
      itemConsumption: [{ rawMaterialId: rid, qty: 0.25 }],
      choices: {},
    };
    const materials = { [rid]: { currentQty: 0, baseUnit: 'pcs' } };
    expect(isItemServingBlocked(itemBom, materials, new Map())).toBe(true);
  });

  it('computeCartRawDemand sums option consumption', () => {
    const snapshot = {
      enabled: true,
      materials: { [rid]: { currentQty: 1, baseUnit: 'pcs' } },
      items: {
        [itemId]: {
          itemConsumption: [],
          choices: { [choiceId]: [{ rawMaterialId: rid, qty: 0.25 }] },
        },
      },
    };
    const demand = computeCartRawDemand([{
      menuItemId: itemId,
      quantity: 2,
      options: [{ choiceId }],
    }], snapshot);
    expect(demand.get(rid)).toBe(0.5);
  });

  it('demandForOneServing merges item and choices', () => {
    const itemBom = {
      itemConsumption: [{ rawMaterialId: rid, qty: 0.1 }],
      choices: { [choiceId]: [{ rawMaterialId: rid, qty: 0.25 }] },
    };
    const d = demandForOneServing(itemBom, [choiceId]);
    expect(d.get(rid)).toBe(0.35);
    expect(canSatisfyDemand(d, { [rid]: { currentQty: 0.3, baseUnit: 'pcs' } })).toBe(false);
    expect(canSatisfyDemand(d, { [rid]: { currentQty: 0.35, baseUnit: 'pcs' } })).toBe(true);
  });

  it('mergeDemandMaps adds quantities', () => {
    const a = new Map([[rid, 0.25]]);
    const b = new Map([[rid, 0.25]]);
    expect(mergeDemandMaps(a, b).get(rid)).toBe(0.5);
  });
});

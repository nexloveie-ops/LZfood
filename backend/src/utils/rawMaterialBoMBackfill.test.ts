import mongoose from 'mongoose';
import {
  bomLinkSignature,
  collectLinkedRawMaterialIds,
  rawMaterialIdsNeedingBackfillOnBoMChange,
} from './rawMaterialBoMBackfill';

const ridA = new mongoose.Types.ObjectId().toString();
const ridB = new mongoose.Types.ObjectId().toString();

describe('rawMaterialBoMBackfill', () => {
  it('collectLinkedRawMaterialIds gathers item and option links', () => {
    expect(
      collectLinkedRawMaterialIds(
        [{ rawMaterialId: ridA, qty: 100 }],
        [{
          translations: [{ locale: 'zh-CN', name: '选择1' }],
          choices: [{
            translations: [{ locale: 'zh-CN', name: '烧鸭' }],
            consumption: [{ rawMaterialId: ridB, qty: 250 }],
          }],
        }],
      ).sort(),
    ).toEqual([ridA, ridB].sort());
  });

  it('rawMaterialIdsNeedingBackfillOnBoMChange returns empty when BoM unchanged', () => {
    const cons = [{ rawMaterialId: ridA, qty: 450 }];
    expect(rawMaterialIdsNeedingBackfillOnBoMChange(cons, [], cons, [])).toEqual([]);
  });

  it('rawMaterialIdsNeedingBackfillOnBoMChange returns union when qty changes', () => {
    const before = [{ rawMaterialId: ridA, qty: 450 }];
    const after = [{ rawMaterialId: ridA, qty: 500 }];
    expect(rawMaterialIdsNeedingBackfillOnBoMChange(before, [], after, []).sort()).toEqual([ridA]);
  });

  it('rawMaterialIdsNeedingBackfillOnBoMChange returns both ids when link removed and added', () => {
    const before = [{ rawMaterialId: ridA, qty: 450 }];
    const after = [{ rawMaterialId: ridB, qty: 250 }];
    expect(rawMaterialIdsNeedingBackfillOnBoMChange(before, [], after, []).sort()).toEqual([ridA, ridB].sort());
  });

  it('bomLinkSignature differs when option BoM changes', () => {
    const groups = [{
      translations: [{ locale: 'zh-CN', name: '选择1' }],
      choices: [{
        translations: [{ locale: 'zh-CN', name: '烧鸭' }],
        consumption: [{ rawMaterialId: ridA, qty: 250 }],
      }],
    }];
    const changed = [{
      ...groups[0],
      choices: [{
        translations: [{ locale: 'zh-CN', name: '烧鸭' }],
        consumption: [{ rawMaterialId: ridA, qty: 300 }],
      }],
    }];
    expect(bomLinkSignature([], groups)).not.toBe(bomLinkSignature([], changed));
  });
});

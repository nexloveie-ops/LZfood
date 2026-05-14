import mongoose from 'mongoose';
import { cloneOptionGroupsPreservingSubdocIds, validateOptionGroups, type LeanOptionGroup } from './optionGroups';

describe('validateOptionGroups', () => {
  it('rejects optional group when minSelect > maxSelect', () => {
    const bad: LeanOptionGroup[] = [
      {
        required: false,
        minSelect: 3,
        maxSelect: 2,
        translations: [{ locale: 'zh-CN', name: 'Topping' }],
        choices: [
          { translations: [{ locale: 'zh-CN', name: 'A' }], extraPrice: 0 },
          { translations: [{ locale: 'zh-CN', name: 'B' }], extraPrice: 0 },
        ],
      },
    ];
    expect(() => validateOptionGroups(bad)).toThrow();
  });
});

describe('cloneOptionGroupsPreservingSubdocIds', () => {
  const gid = new mongoose.Types.ObjectId();
  const cid = new mongoose.Types.ObjectId();

  const sample: LeanOptionGroup[] = [
    {
      _id: gid,
      required: true,
      translations: [{ locale: 'zh-CN', name: '规格' }],
      choices: [
        {
          _id: cid,
          translations: [{ locale: 'zh-CN', name: '大' }],
          extraPrice: 1,
        },
      ],
    },
  ];

  it('preserves existing group and choice ObjectIds across clones', () => {
    const a = cloneOptionGroupsPreservingSubdocIds(sample);
    const b = cloneOptionGroupsPreservingSubdocIds(sample);
    expect(a[0]._id?.toString()).toBe(gid.toString());
    expect(a[0].choices[0]._id?.toString()).toBe(cid.toString());
    expect(b[0]._id?.toString()).toBe(gid.toString());
  });

  it('generates new ids when missing', () => {
    const bare: LeanOptionGroup[] = [
      {
        required: false,
        translations: [{ locale: 'zh-CN', name: 'G' }],
        choices: [{ translations: [{ locale: 'zh-CN', name: 'C' }], extraPrice: 0 }],
      },
    ];
    const x = cloneOptionGroupsPreservingSubdocIds(bare);
    expect(x[0]._id).toBeDefined();
    expect(x[0].choices[0]._id).toBeDefined();
  });
});

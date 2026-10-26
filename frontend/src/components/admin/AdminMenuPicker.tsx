import { useTranslation } from 'react-i18next';
import { adminMenuName, type AdminMenu } from '../../hooks/useAdminMenus';

export default function AdminMenuPicker({
  menus,
  menuId,
  onChange,
}: {
  menus: AdminMenu[];
  menuId: string;
  onChange: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  if (menus.length === 0) return null;
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('admin.menus')}</span>
      <select
        className="input"
        value={menuId}
        onChange={(e) => onChange(e.target.value)}
        style={{ minWidth: 180 }}
      >
        {menus.map((menu) => (
          <option key={menu._id} value={menu._id}>
            {adminMenuName(menu, i18n.language)}
            {menu.isDefault ? ` (${t('admin.menuDefault')})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

import { Home, Bot, TrendingUp, DollarSign, Settings } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

const navItems = [
  { icon: Home, label: 'Dashboard', path: '/' },
  { icon: Bot, label: 'Bots', path: '/bots' },
  { icon: TrendingUp, label: 'Strategies', path: '/strategies' },
  { icon: TrendingUp, label: 'Positions', path: '/positions' },
  { icon: DollarSign, label: 'Transactions', path: '/transactions' },
  { icon: Settings, label: 'Settings', path: '/settings' },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <aside
      className={`border-r border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-950 transition-all duration-300 ${
        collapsed ? 'w-20' : 'w-64'
      }`}
    >
      <div className="flex items-center justify-between px-4 py-5 border-b border-gray-100 dark:border-gray-800">
        {!collapsed && (
          <div>
            <p className="text-xs uppercase tracking-widest text-gray-400">Crypto Bot Pro</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">Control Center</p>
          </div>
        )}
        <Button variant="ghost" size="icon" onClick={() => setCollapsed((prev) => !prev)}>
          {collapsed ? '→' : '←'}
        </Button>
      </div>
      <nav className="p-4 space-y-2">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium ${
                isActive
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600'
                  : 'text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-900'
              }`
            }
          >
            <item.icon className="w-4 h-4" />
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}


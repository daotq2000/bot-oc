import { Routes, Route, Navigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { DashboardPage } from '@/pages/Dashboard';
import { BotsPage } from '@/pages/Bots';
import { BotDetailPage } from '@/pages/BotDetail';
import { StrategiesPage } from '@/pages/Strategies';
import { PositionsPage } from '@/pages/Positions';
import { TransactionsPage } from '@/pages/Transactions';
import { SettingsPage } from '@/pages/Settings';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';

function App() {
  return (
    <ErrorBoundary>
      <MainLayout>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/bots" element={<BotsPage />} />
          <Route path="/bots/:id" element={<BotDetailPage />} />
          <Route path="/strategies" element={<StrategiesPage />} />
          <Route path="/positions" element={<PositionsPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </MainLayout>
    </ErrorBoundary>
  );
}

export default App;

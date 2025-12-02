import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDateTime } from '@/utils/formatters';

export function TransactionsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['transactions'],
    queryFn: api.getTransactions,
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Transactions" description="History of transfers and withdrawals." />
      {isLoading ? (
        <LoadingSpinner fullScreen />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Bot</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.map((tx) => (
              <TableRow key={tx.id}>
                <TableCell>{formatDateTime(tx.createdAt)}</TableCell>
                <TableCell>{tx.type}</TableCell>
                <TableCell>{formatCurrency(tx.amount)}</TableCell>
                <TableCell className="capitalize">{tx.status}</TableCell>
                <TableCell>{tx.botId}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}


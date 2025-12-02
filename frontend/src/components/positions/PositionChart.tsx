import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer } from 'recharts';

interface PositionChartProps {
  data: Array<{ time: string; price: number }>;
}

export function PositionChart({ data }: PositionChartProps) {
  return (
    <div className="h-40">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <XAxis dataKey="time" hide />
          <YAxis hide />
          <Area type="monotone" dataKey="price" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}


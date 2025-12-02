interface StrategyCalcParams {
  openPrice: number;
  oc: number;
  extend: number;
  amount: number;
  takeProfit: number;
}

export const calculateStrategy = ({
  openPrice,
  oc,
  extend,
  amount,
  takeProfit,
}: StrategyCalcParams) => {
  const ocDecimal = oc / 100;
  const extendDecimal = extend / 100;
  const tpDecimal = (oc * takeProfit) / 100000;

  const longEntry = openPrice * (1 - ocDecimal * extendDecimal);
  const longTP = longEntry * (1 + tpDecimal);
  const longProfit = amount * tpDecimal;

  const shortEntry = openPrice * (1 + ocDecimal * extendDecimal);
  const shortTP = shortEntry * (1 - tpDecimal);
  const shortProfit = amount * tpDecimal;

  return {
    longEntry,
    longTP,
    longProfit,
    shortEntry,
    shortTP,
    shortProfit,
  };
};


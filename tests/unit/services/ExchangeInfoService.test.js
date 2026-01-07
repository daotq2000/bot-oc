import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ExchangeInfoService } from '../../../src/services/ExchangeInfoService.js';

describe('ExchangeInfoService - Symbol Sync (unit)', () => {
  let svc;
  let mockDAO;
  let mockLogger;
  let mockConfig;
  let mockBinanceClient;
  let mockMexc;

  beforeEach(() => {
    mockDAO = {
      findAll: jest.fn(),
      bulkUpsert: jest.fn().mockResolvedValue(undefined),
      deleteByExchangeAndSymbols: jest.fn().mockResolvedValue(0),
      getSymbolsByExchange: jest.fn().mockResolvedValue([]),
    };
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    mockConfig = { getBoolean: jest.fn().mockReturnValue(true) };
    mockBinanceClient = { getExchangeInfo: jest.fn() };
    mockMexc = {
      markets: {},
      fetchMarkets: jest.fn().mockResolvedValue(undefined),
      loadMarkets: jest.fn().mockResolvedValue(undefined),
      urls: {},
      hostname: 'mexc.co',
      fetch: jest.fn(),
    };
    svc = new ExchangeInfoService({
      symbolFilterDAO: mockDAO,
      binanceClientFactory: () => mockBinanceClient,
      mexcFactory: () => mockMexc,
      loggerInst: mockLogger,
      config: mockConfig,
    });
  });

  describe('Binance: updateFiltersFromExchange', () => {
    it('inserts new symbols from exchange', async () => {
      mockBinanceClient.getExchangeInfo.mockResolvedValue({
        symbols: [
          {
            symbol: 'BTCUSDT',
            status: 'TRADING',
            filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', stepSize: '0.001' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
            leverageBrackets: [{ initialLeverage: 125 }],
          },
          {
            symbol: 'ETHUSDT',
            status: 'TRADING',
            filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', stepSize: '0.001' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
            leverageBrackets: [{ initialLeverage: 100 }],
          },
        ],
      });

      const clearSpy = jest.spyOn(svc.filtersCache, 'clear');
      svc.loadFiltersFromDB = jest.fn().mockResolvedValue(undefined);

      await svc.updateFiltersFromExchange();

      expect(mockDAO.getSymbolsByExchange).toHaveBeenCalledWith('binance');
      expect(mockDAO.deleteByExchangeAndSymbols).toHaveBeenCalledWith('binance', ['BTCUSDT', 'ETHUSDT']);
      expect(mockDAO.bulkUpsert).toHaveBeenCalledWith([
        {
          exchange: 'binance',
          symbol: 'BTCUSDT',
          tick_size: '0.01',
          step_size: '0.001',
          min_notional: '5',
          max_leverage: 125,
        },
        {
          exchange: 'binance',
          symbol: 'ETHUSDT',
          tick_size: '0.01',
          step_size: '0.001',
          min_notional: '5',
          max_leverage: 100,
        },
      ]);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(svc.loadFiltersFromDB).toHaveBeenCalledTimes(1);
    });

    it('deletes symbols not returned by exchange (delisted/unavailable) and clears cache', async () => {
      mockBinanceClient.getExchangeInfo.mockResolvedValue({
        symbols: [
          {
            symbol: 'BTCUSDT',
            status: 'TRADING',
            filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', stepSize: '0.001' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
          },
        ],
      });
      mockDAO.getSymbolsByExchange.mockResolvedValue(['BTCUSDT', 'SOLUSDT', 'ABCUSDT']);
      mockDAO.deleteByExchangeAndSymbols.mockResolvedValue(2);

      const clearSpy = jest.spyOn(svc.filtersCache, 'clear');
      svc.loadFiltersFromDB = jest.fn().mockResolvedValue(undefined);

      await svc.updateFiltersFromExchange();

      expect(mockDAO.deleteByExchangeAndSymbols).toHaveBeenCalledWith('binance', ['BTCUSDT']);
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Deleted 2 delisted/unavailable Binance symbols'));
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(svc.loadFiltersFromDB).toHaveBeenCalledTimes(1);
    });

    it('keeps existing symbols that are still available (no deletions) and clears cache', async () => {
      mockBinanceClient.getExchangeInfo.mockResolvedValue({
        symbols: [
          {
            symbol: 'BTCUSDT', status: 'TRADING', filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', stepSize: '0.001' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
          },
          {
            symbol: 'ETHUSDT', status: 'TRADING', filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', stepSize: '0.001' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
          },
        ],
      });
      mockDAO.getSymbolsByExchange.mockResolvedValue(['BTCUSDT', 'ETHUSDT']);
      mockDAO.deleteByExchangeAndSymbols.mockResolvedValue(0);
      const clearSpy = jest.spyOn(svc.filtersCache, 'clear');
      svc.loadFiltersFromDB = jest.fn().mockResolvedValue(undefined);

      await svc.updateFiltersFromExchange();

      expect(mockDAO.deleteByExchangeAndSymbols).toHaveBeenCalledWith('binance', ['BTCUSDT', 'ETHUSDT']);
      expect(mockDAO.bulkUpsert).toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(svc.loadFiltersFromDB).toHaveBeenCalledTimes(1);
    });

    it('does not insert spot-only symbols when not present in Futures list', async () => {
      // Imagine SPOTONLYUSDT exists on Spot, but Futures API does not return it.
      mockBinanceClient.getExchangeInfo.mockResolvedValue({
        symbols: [
          {
            symbol: 'BTCUSDT',
            status: 'TRADING',
            filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', stepSize: '0.001' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
          },
        ],
      });
      const clearSpy = jest.spyOn(svc.filtersCache, 'clear');
      svc.loadFiltersFromDB = jest.fn().mockResolvedValue(undefined);

      await svc.updateFiltersFromExchange();

      // Ensure upsert only contains Futures symbols (BTCUSDT), not SPOTONLYUSDT
      const upsertArg = mockDAO.bulkUpsert.mock.calls[0][0];
      expect(upsertArg.map(x => x.symbol)).toEqual(['BTCUSDT']);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(svc.loadFiltersFromDB).toHaveBeenCalledTimes(1);
    });

    it('fail-safe when exchange returns empty symbols: no mass deletion and cache cleared', async () => {
      mockBinanceClient.getExchangeInfo.mockResolvedValue({ symbols: [] });
      const clearSpy = jest.spyOn(svc.filtersCache, 'clear');
      svc.loadFiltersFromDB = jest.fn().mockResolvedValue(undefined);

      await svc.updateFiltersFromExchange();

      expect(mockDAO.deleteByExchangeAndSymbols).toHaveBeenCalledWith('binance', []);
      expect(mockDAO.bulkUpsert).toHaveBeenCalledWith([]);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(svc.loadFiltersFromDB).toHaveBeenCalledTimes(1);
    });

    it('skips non-TRADING and missing-filter symbols', async () => {
      mockBinanceClient.getExchangeInfo.mockResolvedValue({
        symbols: [
          {
            symbol: 'BTCUSDT', status: 'TRADING', filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', stepSize: '0.001' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
          },
          {
            symbol: 'DELISTEDUSDT', status: 'BREAK', filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', stepSize: '0.001' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
          },
          {
            symbol: 'INVALIDUSDT', status: 'TRADING', filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
            ],
          },
        ],
      });
      svc.loadFiltersFromDB = jest.fn().mockResolvedValue(undefined);

      await svc.updateFiltersFromExchange();

      expect(mockDAO.bulkUpsert).toHaveBeenCalledWith([
        {
          exchange: 'binance', symbol: 'BTCUSDT', tick_size: '0.01', step_size: '0.001', min_notional: '5', max_leverage: 125,
        },
      ]);
    });

    it('logs error and does not upsert when fetch throws', async () => {
      const err = new Error('Network');
      mockBinanceClient.getExchangeInfo.mockRejectedValue(err);

      await svc.updateFiltersFromExchange();

      expect(mockLogger.error).toHaveBeenCalledWith('Error updating symbol filters (Binance):', err);
      expect(mockDAO.bulkUpsert).not.toHaveBeenCalled();
    });
  });

  describe('MEXC: updateMexcFiltersFromExchange', () => {
    it('inserts new and deletes delisted for MEXC', async () => {
      mockMexc.markets = {
        'BTC/USDT:USDT': {
          base: 'BTC', quote: 'USDT', type: 'swap', contract: true, active: true,
          precision: { price: 2, amount: 3 },
          limits: { cost: { min: 5 }, leverage: { max: 125 } },
          info: {},
        },
      };

      mockDAO.getSymbolsByExchange.mockResolvedValue(['ETHUSDT']);
      mockDAO.deleteByExchangeAndSymbols.mockResolvedValue(1);
      svc.loadFiltersFromDB = jest.fn().mockResolvedValue(undefined);

      await svc.updateMexcFiltersFromExchange();

      expect(mockDAO.getSymbolsByExchange).toHaveBeenCalledWith('mexc');
      expect(mockDAO.deleteByExchangeAndSymbols).toHaveBeenCalledWith('mexc', ['BTCUSDT']);
      expect(mockDAO.bulkUpsert).toHaveBeenCalledWith([
        {
          exchange: 'mexc', symbol: 'BTCUSDT', tick_size: '0.01', step_size: '0.001', min_notional: 5, max_leverage: 125,
        },
      ]);
      expect(svc.loadFiltersFromDB).toHaveBeenCalled();
    });
  });
});

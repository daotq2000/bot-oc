# 内存优化指南 - 最终方案

## 概述
本文档描述了已实施的内存优化措施，目标是将内存使用从6GB降低到2-3GB以下。

## 已实施的优化措施

### 1. 大幅减少缓存大小（减少70-90%）

#### 缓存大小调整：

| 缓存 | 原大小 | 新大小 | 减少比例 |
|------|--------|--------|----------|
| OrderStatusCache | 10,000 | 500 | 95% |
| RealtimeOCDetector.openPriceCache | 10,000 | 2,000 | 80% |
| RealtimeOCDetector.openFetchCache | 5,000 | 500 | 90% |
| RealtimeOCDetector.lastPriceCache | 5,000 | 1,000 | 80% |
| ExchangeInfoService.filtersCache | 10,000 | 2,000 | 80% |
| WebSocketManager.priceCache | 5,000 | 1,000 | 80% |
| MexcWebSocketManager.priceCache | 5,000 | 1,000 | 80% |
| BinanceDirectClient.restPriceFallbackCache | 1,000 | 200 | 80% |
| ExchangeService._tickerCache | 500 | 200 | 60% |

**预期内存节省**: 约2-3GB（取决于实际使用情况）

### 2. 更频繁的缓存清理

#### 清理间隔调整：

| 服务 | 原间隔 | 新间隔 | 改进 |
|------|--------|--------|------|
| OrderStatusCache | 60秒 | 30秒 | 2倍频率 |
| WebSocketManager | 5分钟 | 1分钟 | 5倍频率 |
| ExchangeInfoService | 30分钟 | 2分钟 | 15倍频率 |
| ExchangeInfoService TTL | 60分钟 | 10分钟 | 6倍频率 |
| WebSocketManager TTL | 10分钟 | 5分钟 | 2倍频率 |

**预期内存节省**: 约500MB-1GB（通过及时清理过期数据）

### 3. 内存监控和自动清理

#### 新增功能：
- **MemoryMonitor**: 自动监控内存使用情况
- **自动清理**: 当内存超过阈值时自动触发清理
- **阈值设置**:
  - 警告阈值: 2GB (默认)
  - 严重阈值: 3GB (默认)
  - 最大内存: 4GB (默认)

#### 配置参数（环境变量）：
```bash
MEMORY_CHECK_INTERVAL_MS=60000        # 检查间隔（毫秒）
MEMORY_WARNING_THRESHOLD_MB=2048      # 警告阈值（MB）
MEMORY_CRITICAL_THRESHOLD_MB=3072     # 严重阈值（MB）
MAX_MEMORY_MB=4096                    # 最大内存（MB）
```

### 4. 日志优化（之前已完成）

- 日志文件大小: 10MB → 5MB
- 日志文件数量: 5个 → 3个
- 日志级别: 高频操作从 `info` → `debug`
- `combined.log` 默认只记录 `warn` 及以上级别

**预期内存节省**: 约200-500MB

## 预期效果

### 内存使用：
- **之前**: ~6GB
- **预期**: 2-3GB（减少50-67%）

### 关键优化点：
1. **OrderStatusCache**: 从10,000减少到500（减少95%）
2. **价格缓存**: 所有价格相关缓存减少70-90%
3. **更频繁清理**: 过期数据及时清理，防止累积
4. **自动监控**: 内存超过阈值时自动清理

## 使用建议

### 1. 生产环境配置

```bash
# 设置日志级别为warn以减少日志输出
export LOG_LEVEL=warn

# 内存监控配置（可选，使用默认值也可以）
export MEMORY_CHECK_INTERVAL_MS=60000
export MEMORY_WARNING_THRESHOLD_MB=2048
export MEMORY_CRITICAL_THRESHOLD_MB=3072
export MAX_MEMORY_MB=4096
```

### 2. 启用GC（可选，用于更激进的清理）

```bash
# 启动时添加 --expose-gc 标志
node --expose-gc --max-old-space-size=3072 src/app.js
```

### 3. 监控内存使用

MemoryMonitor会自动记录内存使用情况。查看日志：
```bash
tail -f logs/combined.log | grep MemoryMonitor
```

## 进一步优化建议（如果内存仍然高）

### 1. 使用Redis（可选）

如果内存仍然高，可以考虑将部分缓存移到Redis：
- **适合移到Redis的缓存**:
  - ExchangeInfoService.filtersCache（symbol filters）
  - StrategyCache（策略缓存）
  - OrderStatusCache（订单状态）

- **不适合移到Redis的缓存**:
  - WebSocket价格缓存（需要极低延迟）
  - RealtimeOCDetector缓存（高频更新）

### 2. 减少WebSocket订阅

如果订阅的symbols太多，可以考虑：
- 只订阅活跃策略的symbols
- 定期清理不活跃的订阅

### 3. 数据库查询优化

- 使用索引优化查询
- 减少不必要的JOIN操作
- 使用分页查询大量数据

### 4. 代码优化

- 避免创建大对象
- 及时释放不需要的引用
- 使用流式处理大数据集

## 监控和调试

### 查看内存使用情况

```bash
# 查看进程内存
ps aux | grep node

# 查看详细内存统计（如果启用了MemoryMonitor）
tail -f logs/combined.log | grep "MemoryMonitor"
```

### 手动触发清理

如果需要手动触发清理，可以通过API或直接调用：
```javascript
const { memoryMonitor } = await import('./src/utils/MemoryMonitor.js');
await memoryMonitor.triggerCleanup(true); // true = aggressive cleanup
```

## 注意事项

1. **缓存大小减少可能影响性能**: 
   - 某些数据可能需要更频繁地从数据库或API获取
   - 监控API调用频率，确保不会触发限流

2. **清理频率增加可能增加CPU使用**:
   - 更频繁的清理会增加CPU使用
   - 但通常影响很小，因为清理操作很快

3. **内存监控开销**:
   - MemoryMonitor每60秒检查一次内存
   - 开销很小，可以忽略

4. **测试建议**:
   - 在生产环境部署前充分测试
   - 监控内存使用趋势至少24小时
   - 确保所有功能正常工作

## 文件变更清单

### 新增文件：
- `src/utils/MemoryMonitor.js` - 内存监控和自动清理
- `MEMORY_OPTIMIZATION_GUIDE.md` - 本文档

### 修改的文件：
- `src/services/OrderStatusCache.js` - 缓存大小和清理频率
- `src/services/RealtimeOCDetector.js` - 缓存大小
- `src/services/ExchangeInfoService.js` - 缓存大小和清理频率
- `src/services/WebSocketManager.js` - 缓存大小和清理频率
- `src/services/MexcWebSocketManager.js` - 缓存大小
- `src/services/BinanceDirectClient.js` - 缓存大小
- `src/services/ExchangeService.js` - 缓存大小和TTL
- `src/app.js` - 集成MemoryMonitor

## 总结

通过大幅减少缓存大小、更频繁的清理和自动内存监控，预期可以将内存使用从6GB降低到2-3GB，减少50-67%。

如果内存仍然高，可以考虑：
1. 使用Redis存储部分缓存
2. 进一步减少缓存大小
3. 优化代码逻辑，减少内存占用

建议在生产环境部署后监控24小时，根据实际情况调整参数。


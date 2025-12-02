# Giải thích về cách tính OC (Open-Close) và biến động

## 📊 OC là gì?

**OC (Open-Close)** là phần trăm biến động giữa giá mở và giá đóng của một nến:

```
OC = (close - open) / open * 100
```

## ⚠️ Quan niệm sai lầm phổ biến

**Sai:** Nến 5 phút sẽ có OC >= nến 1 phút

**Đúng:** OC được tính **độc lập** cho từng nến, không phải là tổng hợp của các nến nhỏ hơn.

## 🔍 Ví dụ minh họa

### Scenario 1: Nến 1 phút có OC cao hơn nến 5 phút

```
Thời gian: 10:00 - 10:05 (5 phút)

Nến 1 phút (10:00-10:01):
  Open:  100
  Close: 102
  OC:    +2.0%

Nến 1 phút (10:01-10:02):
  Open:  102
  Close: 101
  OC:    -0.98%

Nến 1 phút (10:02-10:03):
  Open:  101
  Close: 100
  OC:    -0.99%

Nến 1 phút (10:03-10:04):
  Open:  100
  Close: 99
  OC:    -1.0%

Nến 1 phút (10:04-10:05):
  Open:  99
  Close: 100
  OC:    +1.01%

─────────────────────────────────
Nến 5 phút (10:00-10:05):
  Open:  100
  Close: 100
  OC:    0.0%  ← THẤP HƠN nến 1 phút đầu tiên (+2.0%)
```

**Kết luận:** Nến 5 phút có OC = 0%, trong khi nến 1 phút đầu có OC = +2%.

### Scenario 2: Nến 5 phút có OC cao hơn nến 1 phút

```
Thời gian: 10:00 - 10:05 (5 phút)

Nến 1 phút (10:00-10:01):
  Open:  100
  Close: 100.5
  OC:    +0.5%

Nến 1 phút (10:01-10:02):
  Open:  100.5
  Close: 101
  OC:    +0.5%

Nến 1 phút (10:02-10:03):
  Open:  101
  Close: 101.5
  OC:    +0.5%

Nến 1 phút (10:03-10:04):
  Open:  101.5
  Close: 102
  OC:    +0.5%

Nến 1 phút (10:04-10:05):
  Open:  102
  Close: 102.5
  OC:    +0.5%

─────────────────────────────────
Nến 5 phút (10:00-10:05):
  Open:  100
  Close: 102.5
  OC:    +2.5%  ← CAO HƠN tất cả nến 1 phút (+0.5%)
```

**Kết luận:** Nến 5 phút có OC = +2.5%, cao hơn từng nến 1 phút riêng lẻ.

## 📈 Range vs OC

**Range (High - Low)** thường tăng theo khung thời gian dài hơn, nhưng **OC** thì không:

```
Nến 1 phút:
  Open:  100
  High:  102
  Low:   99
  Close: 100.5
  OC:    +0.5%
  Range: 3.0%  (high - low)

Nến 5 phút:
  Open:  100
  High:  103
  Low:   98
  Close: 100.5
  OC:    +0.5%  ← BẰNG nến 1 phút
  Range: 5.0%  ← CAO HƠN nến 1 phút
```

## 🎯 Tại sao OC không nhất thiết tăng theo khung thời gian?

1. **OC chỉ đo sự khác biệt giữa open và close**
   - Không phụ thuộc vào high/low
   - Không phụ thuộc vào biến động trong khoảng thời gian

2. **Giá có thể dao động nhiều nhưng kết thúc gần điểm bắt đầu**
   ```
   Nến 5 phút:
   Open:  100
   High:  105  (tăng 5%)
   Low:   95   (giảm 5%)
   Close: 100  (quay về điểm bắt đầu)
   OC:    0%   ← Mặc dù có biến động lớn
   ```

3. **Mỗi nến tính OC độc lập**
   - Nến 5 phút không phải là tổng của 5 nến 1 phút
   - Nến 5 phút chỉ so sánh open và close của chính nó

## 💡 Kết luận

- ✅ **Range (High - Low)** thường tăng theo khung thời gian dài hơn
- ❌ **OC (Open-Close)** KHÔNG nhất thiết tăng theo khung thời gian dài hơn
- ✅ **OC** được tính độc lập cho từng nến
- ✅ **OC** chỉ đo sự khác biệt giữa giá mở và giá đóng

## 🔧 Code hiện tại

Bot tính OC như sau:

```javascript
// src/utils/calculator.js
export function calculateOC(open, close) {
  if (!open || open === 0) return 0;
  return ((close - open) / open) * 100;
}
```

**Cách tính này là ĐÚNG** - mỗi nến tính OC độc lập dựa trên open và close của chính nó.

## 📊 So sánh thực tế

Để kiểm tra, bạn có thể chạy:

```bash
node test_oc_comparison.js
```

Script này sẽ so sánh OC giữa các khung thời gian khác nhau và cho thấy rằng:
- OC của nến 5 phút KHÔNG nhất thiết >= OC của nến 1 phút
- Range của nến 5 phút thường >= Range của nến 1 phút


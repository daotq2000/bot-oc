# Bot Creation Form - Layout Options

## Overview
The bot creation form has been redesigned with multiple layout options to provide flexibility in how users create and manage bots.

## Layout Options

### 1. **Full-Page Card Layout** (Recommended)
**File:** `BotFormCard.tsx`
**Usage:** `Bots.tsx`

This is the primary layout where the form takes up the full width as a card. When the user clicks "Add Bot", the bot list is replaced with the form card.

**Features:**
- Full-width form card with all sections visible
- Large, easy-to-read labels and inputs
- Organized into 4 main sections:
  - Basic Information
  - API Credentials
  - Trading Settings
  - Withdrawal Settings
- Security warning for API credentials
- Helpful tooltips for each field
- Clear visual hierarchy with section headers and icons

**Best for:**
- Desktop users
- First-time bot creation
- Users who need detailed guidance

**Layout:**
```
┌─────────────────────────────────────────┐
│ Create New Bot                        X │
│ Configure your bot settings...          │
├─────────────────────────────────────────┤
│ ⚙️ Basic Information                    │
│ ├─ Bot Name: [____________]             │
│ └─ Exchange: [MEXC ▼]                   │
│                                         │
│ 🔑 API Credentials                      │
│ ├─ ⚠️ Keep credentials secure           │
│ ├─ Access Key: [____________]           │
│ ├─ Secret Key: [____________]           │
│ ├─ UID: [____________]                  │
│ └─ Proxy: [____________]                │
│                                         │
│ ⚡ Trading Settings                     │
│ ├─ Future Balance: [$20]                │
│ ├─ Spot Balance: [$10]                  │
│ ├─ Transfer Freq: [15 min]              │
│ └─ Transfer Threshold: [$10]            │
│                                         │
│ 💳 Withdrawal Settings                  │
│ ├─ Auto Withdrawal: [Toggle]            │
│ ├─ Withdraw Address: [____________]     │
│ └─ Telegram ID: [____________]          │
│                                         │
│ [Cancel] [Create Bot]                   │
└─────────────────────────────────────────┘
```

### 2. **Compact Card Layout** (Grid-Friendly)
**File:** `BotFormCardCompact.tsx`
**Usage:** `BotsGridLayout.tsx`

This is a compact version designed to fit in a grid layout alongside existing bot cards. The form card appears as one item in the grid.

**Features:**
- Compact form that fits in a grid (md:col-span-1, lg:col-span-1)
- Condensed sections with smaller fonts
- Smaller input fields and buttons
- All sections still present but more compact
- Fits naturally in a 2-3 column grid

**Best for:**
- Users who want to see existing bots while creating new ones
- Tablet/responsive layouts
- Quick form access

**Layout:**
```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ Create New Bot    X │  │ BINANCE             │  │ GATE                │
│ Configure your bot  │  │ running             │  │ running             │
├─────────────────────┤  ├─────────────────────┤  ├─────────────────────┤
│ ⚙️ Basic Info       │  │ PNL 24H: $0.00      │  │ PNL 24H: $0.00      │
│ Bot Name: [_____]   │  │ STRATEGIES: 0       │  │ STRATEGIES: 0       │
│ Exchange: [MEXC ▼]  │  │ OPEN POSITIONS: 0   │  │ OPEN POSITIONS: 0   │
│                     │  │ [View] [Edit]       │  │ [View] [Edit]       │
│ 🔑 API Keys        │  └─────────────────────┘  └─────────────────────┘
│ ⚠️ Keep secure     │
│ Access Key: [___]   │  ┌─────────────────────┐
│ Secret Key: [___]   │  │ GATE                │
│ UID: [___]          │  │ running             │
│ Proxy: [___]        │  ├─────────────────────┤
│                     │  │ PNL 24H: $0.00      │
│ ⚡ Trading         │  │ STRATEGIES: 0       │
│ Future: [$20]       │  │ OPEN POSITIONS: 0   │
│ Spot: [$10]         │  │ [View] [Edit]       │
│ Freq: [15 min]      │  └─────────────────────┘
│ Threshold: [$10]    │
│                     │
│ 💳 Withdrawal      │
│ Auto: [Toggle]      │
│ Address: [_____]    │
│ Telegram: [_____]   │
│                     │
│ [Cancel] [Create]   │
└─────────────────────┘
```

### 3. **Modal Dialog Layout** (Legacy)
**File:** `BotForm.tsx`
**Usage:** Original implementation

This is the original modal dialog approach. Can still be used if needed.

**Features:**
- Form appears in a centered modal
- Overlay on the background
- Good for focused form entry
- Less context about existing bots

## Implementation Guide

### Using Full-Page Layout (Recommended)
```tsx
// In Bots.tsx
import { BotFormCard } from '@/components/bots/BotFormCard';

export function BotsPage() {
  const [showForm, setShowForm] = useState(false);
  
  return (
    <div className="space-y-6">
      <PageHeader title="My Bots" ... />
      
      {showForm ? (
        <BotFormCard 
          onSubmit={handleSubmit} 
          onCancel={() => setShowForm(false)} 
        />
      ) : (
        <BotList bots={data} />
      )}
    </div>
  );
}
```

### Using Grid Layout
```tsx
// In BotsGridLayout.tsx
import { BotFormCardCompact } from '@/components/bots/BotFormCardCompact';

export function BotsGridLayoutPage() {
  const [showForm, setShowForm] = useState(false);
  
  return (
    <div className="space-y-6">
      <PageHeader title="My Bots" ... />
      
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {showForm && (
          <BotFormCardCompact 
            onSubmit={handleSubmit} 
            onCancel={() => setShowForm(false)} 
          />
        )}
        {data?.map(bot => (
          <BotCard key={bot.id} bot={bot} />
        ))}
      </div>
    </div>
  );
}
```

## Component Props

### BotFormCard
```tsx
interface BotFormCardProps {
  defaultValues?: Partial<BotFormData>;  // Pre-fill form values
  onSubmit: (data: BotFormData) => void; // Handle form submission
  onCancel?: () => void;                 // Handle cancel action
}
```

### BotFormCardCompact
```tsx
interface BotFormCardCompactProps {
  defaultValues?: Partial<BotFormData>;  // Pre-fill form values
  onSubmit: (data: BotFormData) => void; // Handle form submission
  onCancel?: () => void;                 // Handle cancel action
}
```

## Styling & Customization

### Colors & Icons
- **Basic Information:** Blue (Settings icon)
- **API Credentials:** Amber (Key icon)
- **Trading Settings:** Green (Zap icon)
- **Withdrawal Settings:** Purple (CreditCard icon)

### Responsive Behavior
- **Mobile:** Single column, full width
- **Tablet:** 2 columns (md:grid-cols-2)
- **Desktop:** 3 columns (xl:grid-cols-3)

### Form Validation
- Uses Zod schema for validation
- Real-time error messages
- Required fields marked with red asterisk (*)
- Helpful tooltips on hover

## Migration Guide

If you're currently using the modal dialog approach:

1. Replace `BotForm` import with `BotFormCard`
2. Remove `Dialog` component wrapper
3. Update state management to use `showForm` boolean instead of `open`
4. Conditionally render the form card or bot list

**Before:**
```tsx
<Dialog open={open} onClose={() => setOpen(false)}>
  <BotForm onSubmit={handleSubmit} />
</Dialog>
```

**After:**
```tsx
{showForm ? (
  <BotFormCard onSubmit={handleSubmit} onCancel={() => setShowForm(false)} />
) : (
  <BotList bots={data} />
)}
```

## Future Enhancements

- [ ] Multi-step form wizard
- [ ] Form templates/presets
- [ ] Import bot configuration from file
- [ ] Duplicate existing bot configuration
- [ ] Form auto-save to localStorage
- [ ] API key validation before submission


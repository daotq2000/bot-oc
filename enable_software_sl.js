/**
 * Enable software SL for all positions that need it
 */

import 'dotenv/config';
import { Position } from './src/models/Position.js';

async function enableSoftwareSLForAll() {
  const openPositions = await Position.findOpen();
  const needsSoftwareSL = openPositions.filter(p => 
    !p.sl_order_id && 
    p.stop_loss_price && 
    (p.use_software_sl === 0 || p.use_software_sl === false || !p.use_software_sl)
  );
  
  console.log('Positions needing software SL: ' + needsSoftwareSL.length);
  
  for (const pos of needsSoftwareSL) {
    await Position.update(pos.id, { use_software_sl: true });
    console.log('Enabled software SL for position ' + pos.id + ' (' + pos.symbol + ')');
  }
  
  console.log('Done!');
  process.exit(0);
}

enableSoftwareSLForAll();

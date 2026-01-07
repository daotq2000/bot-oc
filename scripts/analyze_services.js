#!/usr/bin/env node

/**
 * Analyze services directory usage and conflicts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const servicesDir = path.join(projectRoot, 'src/services');
const srcDir = path.join(projectRoot, 'src');

// Get all service files
const serviceFiles = fs.readdirSync(servicesDir)
  .filter(f => f.endsWith('.js'))
  .map(f => f.replace('.js', ''));

// Find all JS files in src
function getAllJsFiles(dir) {
  const files = [];
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
      files.push(...getAllJsFiles(fullPath));
    } else if (item.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const allJsFiles = getAllJsFiles(srcDir);

// Analyze each service
const analysis = {};

for (const serviceName of serviceFiles) {
  const serviceFile = path.join(servicesDir, `${serviceName}.js`);
  if (!fs.existsSync(serviceFile)) continue;
  
  const serviceContent = fs.readFileSync(serviceFile, 'utf8');
  const serviceFileSize = fs.statSync(serviceFile).size;
  
  // Find files that import this service
  const importers = [];
  const importPatterns = [
    new RegExp(`import.*${serviceName}.*from`, 'i'),
    new RegExp(`require.*${serviceName}`, 'i'),
    new RegExp(`from.*['"]\\.\\.?/.*services/${serviceName}`, 'i'),
  ];
  
  for (const jsFile of allJsFiles) {
    if (jsFile === serviceFile) continue;
    const content = fs.readFileSync(jsFile, 'utf8');
    for (const pattern of importPatterns) {
      if (pattern.test(content)) {
        importers.push(path.relative(projectRoot, jsFile));
        break;
      }
    }
  }
  
  analysis[serviceName] = {
    file: serviceFile,
    size: serviceFileSize,
    importers: [...new Set(importers)],
    isUsed: importers.length > 0,
    lineCount: serviceContent.split('\n').length
  };
}

// Find conflicts (services that handle same operations)
const conflicts = [];

// Check position-related operations
const positionOps = ['updatePosition', 'closePosition', 'createPosition', 'placeExitOrder'];
const positionServices = Object.keys(analysis).filter(s => {
  const content = fs.readFileSync(analysis[s].file, 'utf8');
  return positionOps.some(op => content.includes(op));
});

if (positionServices.length > 1) {
  conflicts.push({
    type: 'position_operations',
    services: positionServices,
    description: 'Multiple services handle position operations (update, close, create, TP/SL)'
  });
}

// Check order-related operations
const orderOps = ['createOrder', 'executeSignal', 'placeOrder'];
const orderServices = Object.keys(analysis).filter(s => {
  const content = fs.readFileSync(analysis[s].file, 'utf8');
  return orderOps.some(op => content.includes(op));
});

if (orderServices.length > 1) {
  conflicts.push({
    type: 'order_operations',
    services: orderServices,
    description: 'Multiple services handle order operations (create, execute)'
  });
}

// Output results
console.log('='.repeat(80));
console.log('SERVICES DIRECTORY ANALYSIS');
console.log('='.repeat(80));
console.log();

console.log('📊 USAGE SUMMARY');
console.log('-'.repeat(80));
const used = Object.entries(analysis).filter(([_, data]) => data.isUsed);
const unused = Object.entries(analysis).filter(([_, data]) => !data.isUsed);

console.log(`✅ Used: ${used.length} files`);
console.log(`❌ Unused: ${unused.length} files`);
console.log();

console.log('✅ FILES IN USE:');
console.log('-'.repeat(80));
for (const [name, data] of used.sort((a, b) => b[1].importers.length - a[1].importers.length)) {
  console.log(`  ${name.padEnd(30)} ${data.importers.length.toString().padStart(3)} importers  ${(data.size / 1024).toFixed(1)}KB`);
  if (data.importers.length <= 3) {
    data.importers.forEach(imp => console.log(`    └─ ${imp}`));
  }
}
console.log();

if (unused.length > 0) {
  console.log('❌ UNUSED FILES:');
  console.log('-'.repeat(80));
  for (const [name, data] of unused) {
    console.log(`  ${name.padEnd(30)} ${(data.size / 1024).toFixed(1)}KB  ${data.lineCount} lines`);
  }
  console.log();
}

if (conflicts.length > 0) {
  console.log('⚠️  POTENTIAL CONFLICTS:');
  console.log('-'.repeat(80));
  for (const conflict of conflicts) {
    console.log(`  ${conflict.type}:`);
    console.log(`    Services: ${conflict.services.join(', ')}`);
    console.log(`    ${conflict.description}`);
    console.log();
  }
}

console.log('='.repeat(80));


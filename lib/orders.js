const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'orders.json');

function readOrders() {
  if (!fs.existsSync(DB_PATH)) return [];
  const raw = fs.readFileSync(DB_PATH, 'utf-8').trim();
  return raw ? JSON.parse(raw) : [];
}

function saveOrder(order) {
  const orders = readOrders();
  orders.push(order);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(orders, null, 2));
  return order;
}

module.exports = { readOrders, saveOrder };

// Run directly with Node: bypass the Vitest Phaser alias and use installed classes.
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");

// Phaser's device probes support workers; no DOM or renderer is needed here.
global.importScripts = () => {};
const realRequire = createRequire(require.resolve("phaser/package.json"));
const Container = realRequire("./src/gameobjects/container/Container.js");
const GameObject = realRequire("./src/gameobjects/GameObject.js");
const EventEmitter = realRequire("eventemitter3");
const version = realRequire("./package.json").version;
const list = [];
const displayList = {
  events: new EventEmitter(),
  exists: (obj) => list.includes(obj),
  add: (obj) => list.push(obj),
  remove: (obj) => list.splice(list.indexOf(obj), 1),
  queueDepthSort() {},
};
const scene = { sys: { events: new EventEmitter(), displayList, queueDepthSort() {} } };

const parent = new Container(scene);
const child = new GameObject(scene, "child");
const originalPreDestroy = parent.preDestroy;
parent.preDestroy = function () {
  assert.equal(this.isDestroyed, true);
  originalPreDestroy.call(this);
};
assert.equal(parent.exclusive, true);
assert.equal(child.isDestroyed, false);
assert.equal(child.destroyed, undefined);
parent.add(child);
assert.equal(child.parentContainer, parent);
parent.destroy();
assert.equal(child.isDestroyed, true);
assert.equal(child.destroyed, undefined);
assert.equal(child.scene, undefined);
console.log(
  `Phaser ${version}: exclusive=true; parent.destroy() => child.isDestroyed=true, child.destroyed=undefined, child.scene=undefined`
);

const detachedParent = new Container(scene);
const survivor = new GameObject(scene, "survivor");
detachedParent.add(survivor);
detachedParent.removeAll(false);
detachedParent.destroy();
assert.equal(survivor.isDestroyed, false);
assert.equal(survivor.parentContainer, null);
assert.equal(survivor.displayList, displayList);
console.log(
  "removeAll(false) before destroy => child.isDestroyed=false, parentContainer=null, displayList=scene root"
);

const ignored = new GameObject(scene, "ignored");
ignored.ignoreDestroy = true;
ignored.destroy();
assert.equal(ignored.isDestroyed, false);
console.log(
  "ignoreDestroy=true => isDestroyed stays false; successful destroy sets it before preDestroy"
);

Array.prototype.pushWithLimit = function <T>(
  this: T[],
  elem: T,
  limit: number = 20
): T[] {
  if (this.length >= limit) {
    this.shift();
  }

  this.push(elem);

  return this;
};

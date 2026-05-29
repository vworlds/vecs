// Re-export Vecs' Bitset so vecs-physics uses one bitset implementation across
// both libraries (the engine needs bitsets for awake/enlarged-proxy tracking).
export { Bitset } from "@vworlds/vecs";

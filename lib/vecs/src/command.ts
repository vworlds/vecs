/**
 * Discriminator for the reusable parallel command arrays in `World`.
 *
 * @internal
 */
export const enum CommandKind {
  CreateEntity,
  Set,
  Assign,
  Modified,
  Remove,
  Destroy,
  Attach,
  AddTarget,
  RemoveTarget,
}

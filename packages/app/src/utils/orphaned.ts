// Whether a session minted by a send that then failed should be deleted. A view
// already showing it keeps it: the draft is restored there, and a retry from
// that view sends to it. A view showing anything else would leave it empty and
// unreachable from the composer.
export function orphaned(created: string, viewing: string | undefined) {
  return created !== viewing
}

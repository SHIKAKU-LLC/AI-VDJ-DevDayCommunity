export function CreditName({ name }: { name: string }) {
  return <strong className="stage-credit-name" title={name}>{name}</strong>;
}

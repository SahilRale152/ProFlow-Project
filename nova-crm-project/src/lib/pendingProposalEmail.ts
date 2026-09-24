export type PendingProposalEmail = {
  file: File
  filename: string
  proposalNumber?: string | null
  recipient_email?: string
  recipient_name?: string
  company_name?: string
  subject?: string
}

let pending: PendingProposalEmail | null = null

export function setPendingProposalEmail(data: PendingProposalEmail) {
  pending = data
}

export function takePendingProposalEmail(): PendingProposalEmail | null {
  const value = pending
  pending = null
  return value
}
export interface Product {
  id: number;
  name: string;
  description: string;
  price: number;
  category: string;
}

export interface FollowUp {
  id: number;
  contact_type: string;
  contact_address: string;
  message: string;
  status: string;
  created_at: string;
}

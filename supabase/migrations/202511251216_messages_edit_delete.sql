-- Add columns for Edit and Soft Delete functionality
ALTER TABLE public.messages 
ADD COLUMN is_edited BOOLEAN DEFAULT false,
ADD COLUMN is_deleted BOOLEAN DEFAULT false;

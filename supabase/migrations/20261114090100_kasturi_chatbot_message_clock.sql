-- A chatbot message is stamped with the moment it is written, not the moment
-- its transaction began. The order of a conversation's messages is what says
-- whose turn it is (chatbot_begin_turn, chatbot_finish_turn), so two messages
-- written in one transaction must not share a timestamp.
alter table public.crm_chatbot_messages alter column created_at set default clock_timestamp();

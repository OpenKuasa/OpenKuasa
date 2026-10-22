-- Seeds the Kasturi (CRM) screens that ship empty in the shared demo workspace:
-- a sales pipeline + stages, contacts, deals, landing pages, broadcasts,
-- automations (+ a few runs) and the chatbot (settings, knowledge, conversations,
-- messages). Every other demo module is seeded by its own *_demo_seed.sql; the CRM
-- creation screens were never covered, so a demo visitor saw empty Contacts/Deals/etc.
--
-- Scoped to orgs.slug = 'rimba-ventures-demo' and idempotent: it does nothing if the
-- demo org is absent or already has a pipeline, so a replay never double-seeds.

do $$
declare
  v_org  uuid;
  v_pipe uuid;
  s_new uuid; s_qual uuid; s_prop uuid; s_neg uuid; s_won uuid;
  f_raya uuid; f_consult uuid; f_ebook uuid;
  c_aisyah uuid; c_nurul uuid; c_lim uuid; c_langkawi uuid; c_nusantara uuid;
  conv1 uuid; conv2 uuid; conv3 uuid;
begin
  select id into v_org from public.orgs where slug = 'rimba-ventures-demo';
  if v_org is null then
    raise notice 'rimba-ventures-demo org not found; skipping kasturi demo seed';
    return;
  end if;
  if exists (select 1 from public.crm_pipelines where org_id = v_org) then
    raise notice 'kasturi demo already seeded; skipping';
    return;
  end if;

  -- Reference rows seeded earlier (forms by reach seed, customers by bendahara seed).
  select id into f_raya    from public.forms where org_id = v_org and name = 'Raya Promo Signup'  limit 1;
  select id into f_consult from public.forms where org_id = v_org and name = 'Free Consultation'  limit 1;
  select id into f_ebook   from public.forms where org_id = v_org and name = 'eBook Download'      limit 1;
  select id into c_aisyah    from public.finance_contacts where org_id = v_org and name = 'Aisyah Trading'      limit 1;
  select id into c_nurul     from public.finance_contacts where org_id = v_org and name = 'Nurul Boutique'      limit 1;
  select id into c_lim       from public.finance_contacts where org_id = v_org and name ilike 'Lim Hardware%'   limit 1;
  select id into c_langkawi  from public.finance_contacts where org_id = v_org and name = 'Langkawi Fresh'      limit 1;
  select id into c_nusantara from public.finance_contacts where org_id = v_org and name = 'Nusantara Logistics' limit 1;

  -- 1) Pipeline + stages (deals need a pipeline; the demo guest, a viewer, can never create one).
  insert into public.crm_pipelines (org_id, name, is_default) values (v_org, 'Sales Pipeline', true)
    returning id into v_pipe;
  insert into public.crm_pipeline_stages (org_id, pipeline_id, name, position, probability_percent)
    values (v_org, v_pipe, 'New', 1, 10) returning id into s_new;
  insert into public.crm_pipeline_stages (org_id, pipeline_id, name, position, probability_percent)
    values (v_org, v_pipe, 'Qualified', 2, 30) returning id into s_qual;
  insert into public.crm_pipeline_stages (org_id, pipeline_id, name, position, probability_percent)
    values (v_org, v_pipe, 'Proposal', 3, 55) returning id into s_prop;
  insert into public.crm_pipeline_stages (org_id, pipeline_id, name, position, probability_percent)
    values (v_org, v_pipe, 'Negotiation', 4, 75) returning id into s_neg;
  insert into public.crm_pipeline_stages (org_id, pipeline_id, name, position, probability_percent)
    values (v_org, v_pipe, 'Won', 5, 100) returning id into s_won;

  -- 2) Contacts. Emails are the stable key the deals/automations below join on.
  insert into public.crm_contacts
    (org_id, first_name, last_name, company, email, phone, country, source, status, lead_score, tags, finance_customer_id, last_interaction_at)
  select v_org, r.first_name, r.last_name, r.company, r.email, r.phone, 'MY', r.source, r.status, r.lead_score, r.tags, r.fin_id,
         now() - (r.seen_days || ' days')::interval
  from (values
    ('Aisyah','Rahim','Aisyah Trading','aisyah@aisyahtrading.my','+60123456701','Referral','customer',88,array['vip','wholesale'],c_aisyah,2),
    ('Nurul','Huda','Nurul Boutique','nurul@nurulboutique.my','+60123456702','Website form','customer',80,array['retail'],c_nurul,5),
    ('Wei Jie','Lim','Lim Hardware Sdn Bhd','weijie@limhardware.my','+60123456703','Referral','customer',84,array['wholesale'],c_lim,9),
    ('Faiz','Hakim','Langkawi Fresh','faiz@langkawifresh.my','+60123456704','Trade show','customer',76,array['f&b'],c_langkawi,12),
    ('Siti','Aminah','Nusantara Logistics','siti@nusantaralogistics.my','+60123456705','Referral','customer',82,array['logistics'],c_nusantara,3),
    ('Daniel','Omar','Sri Decor','daniel@sridecor.my','+60123456706','Instagram DM','qualified',66,array['interior'],null,4),
    ('Rajesh','Nair','Zaki Enterprise','rajesh@zakienterprise.my','+60123456707','Website form','qualified',70,array['wholesale'],null,6),
    ('Mei Ling','Chong','Seri Mutiara Enterprise','meiling@serimutiara.my','+60123456708','Facebook lead form','qualified',64,array['retail'],null,8),
    ('Amir','Hakim','Maju Jaya Sdn Bhd','amir@majujaya.my','+60123456709','WhatsApp','contacted',52,array['prospect'],null,1),
    ('Balqis','Lim','Printhub Enterprise','balqis@printhub.my','+60123456710','TikTok bio link','contacted',48,array['print'],null,7),
    ('Hafiz','Tan','Tan & Sons Enterprise','hafiz@tansons.my','+60123456711','Referral','qualified',58,array['wholesale'],null,10),
    ('Intan','Osman','Osman Trading','intan@osmantrading.my','+60123456712','Website form','contacted',44,array['prospect'],null,14)
  ) as r(first_name,last_name,company,email,phone,source,status,lead_score,tags,fin_id,seen_days);

  -- Extra prospects/leads so the contacts list and funnel look real.
  insert into public.crm_contacts
    (org_id, first_name, last_name, company, email, phone, country, source, status, lead_score, tags)
  select v_org, r.first_name, r.last_name, r.company, r.email, r.phone, 'MY', r.source, r.status, r.lead_score, '{}'::text[]
  from (values
    ('Zikri','Wong','Wong Trading','zikri@wongtrading.my','+60123456713','Customer referral','lead',24),
    ('Liyana','Abdullah','Abdullah Retail','liyana@abdullahretail.my','+60123456714','Instagram DM','lead',18),
    ('Danial','Ismail','Ismail Hardware','danial@ismailhardware.my','+60123456715','Facebook lead form','lead',30),
    ('Farah','Chong','Chong Bakery','farah@chongbakery.my','+60123456716','WhatsApp click ad','lead',22),
    ('Syafiq','Yusof','Yusof Motors','syafiq@yusofmotors.my','+60123456717','Website form','lead',16),
    ('Maya','Huda','Huda Collective','maya@hudacollective.my','+60123456718','Instagram DM','lead',28),
    ('Hakim','Noor','Noor Supplies','hakim@noorsupplies.my','+60123456719','TikTok bio link','lead',20),
    ('Rizal','Devi','Devi Textiles','rizal@devitextiles.my','+60123456720','Customer referral','contacted',34),
    ('Nurul','Salleh','Salleh Grocers','nuruls@sallehgrocers.my','+60123456721','Website form','lead',26),
    ('Siti','Karim','Karim Catering','sitik@karimcatering.my','+60123456722','Facebook lead form','contacted',38),
    ('Faiz','Kaur','Kaur Pharmacy','faizk@kaurpharmacy.my','+60123456723','Referral','qualified',56),
    ('Aina','Razak','Razak Interiors','aina@razakinteriors.my','+60123456724','Trade show','lead',21),
    ('Hafiz','Lee','Lee Electronics','hafizl@leeelectronics.my','+60123456725','Website form','lead',19),
    ('Tengku','Zhar','Zhar Holdings','tengku@zharholdings.my','+60123456726','Referral','archived',12)
  ) as r(first_name,last_name,company,email,phone,source,status,lead_score);

  -- 3) Deals across the pipeline (join contacts by email, stages by name).
  insert into public.crm_deals
    (org_id, contact_id, pipeline_id, stage_id, title, value_cents, status, expected_close_date, won_at, lost_at, lost_reason, last_activity_at)
  select v_org, ct.id, v_pipe, st.id, d.title, d.value_cents, d.status,
         case when d.status = 'open' then current_date + (d.days || ' days')::interval end::date,
         case when d.status = 'won'  then now() - (d.days || ' days')::interval end,
         case when d.status = 'lost' then now() - (d.days || ' days')::interval end,
         d.lost_reason,
         now() - (d.days || ' days')::interval
  from (values
    ('aisyah@aisyahtrading.my','Proposal','Wholesale supply — Q4 restock',4500000,'open',21,null),
    ('weijie@limhardware.my','Negotiation','Annual hardware contract',3800000,'open',14,null),
    ('nurul@nurulboutique.my','Qualified','Raya collection order',1250000,'open',30,null),
    ('faiz@langkawifresh.my','New','Fresh produce trial order',620000,'open',45,null),
    ('daniel@sridecor.my','Proposal','Office fit-out package',2800000,'open',18,null),
    ('rajesh@zakienterprise.my','Qualified','Bulk stationery supply',940000,'open',25,null),
    ('meiling@serimutiara.my','New','Gift hampers — festive',480000,'open',40,null),
    ('siti@nusantaralogistics.my','Won','Warehouse racking supply',5200000,'won',8,null),
    ('balqis@printhub.my','Won','Marketing print bundle',360000,'won',15,null),
    ('hafiz@tansons.my','Won','Trade counter restock',1500000,'won',20,null),
    ('amir@majujaya.my','Negotiation','POS hardware refresh',2100000,'lost',12,'Chose a cheaper vendor'),
    ('intan@osmantrading.my','Qualified','Seasonal bulk order',780000,'lost',16,'Budget cut this quarter')
  ) as d(email,stage,title,value_cents,status,days,lost_reason)
  join public.crm_contacts ct on ct.org_id = v_org and ct.email = d.email
  join public.crm_pipeline_stages st on st.org_id = v_org and st.pipeline_id = v_pipe and st.name = d.stage;

  -- 4) Landing pages.
  insert into public.crm_landing_pages
    (org_id, name, headline, subheadline, body, button_label, form_id, status, views_count, leads_count, chat_enabled)
  values
    (v_org,'Raya Promo 2026','Raya deals for your business','Up to 25% off bulk orders this festive season.','Stock up for Raya with wholesale pricing. Leave your details and our team will send the full price list.','Get the price list',f_raya,'published',1240,86,true),
    (v_org,'Free Consultation','Book a free 30-minute consultation','Talk to our team about growing your SME.','Tell us about your business and we will reach out to schedule a free consultation.','Book my slot',f_consult,'published',540,92,false),
    (v_org,'eBook — SME Growth Guide','Download the SME growth guide','10 practical plays to grow a Malaysian SME.','Get the free guide delivered to your inbox.','Send me the guide',f_ebook,'draft',0,0,false);

  -- 5) Broadcasts (two historical sends, one draft). sent_count is trued-up from the
  -- recipient rows below so the "emails sent" figures match what the detail view shows.
  insert into public.crm_broadcasts
    (org_id, name, subject, body, audience_statuses, audience_tags, status, sent_count, failed_count, sent_at, sending_started_at)
  values
    (v_org,'Raya greetings 2026','Selamat Hari Raya from our team','Wishing you and your family a joyful Raya. As a thank you, enjoy 15% off your next order this month.',array['customer'],'{}'::text[],'sent',0,0, now()-interval '20 days', now()-interval '20 days'),
    (v_org,'New product launch','Introducing our new wholesale range','We have just added a new wholesale range. Reply to this email for early-bird pricing.',array['customer','qualified'],'{}'::text[],'sent',0,0, now()-interval '9 days', now()-interval '9 days'),
    (v_org,'Monthly newsletter — November','This month at Rimba Ventures','Here is what is new this month, plus a few tips for your business.',array['customer','qualified','contacted'],'{}'::text[],'draft',0,0,null,null);

  insert into public.crm_broadcast_recipients (org_id, broadcast_id, contact_id, email, status, sent_at)
  select v_org, b.id, c.id, c.email, 'sent', b.sent_at
  from public.crm_broadcasts b
  join public.crm_contacts c on c.org_id = v_org and c.email is not null and c.status = any (b.audience_statuses)
  where b.org_id = v_org and b.status = 'sent';
  update public.crm_broadcasts b
     set sent_count = (select count(*) from public.crm_broadcast_recipients r where r.broadcast_id = b.id)
   where b.org_id = v_org and b.status = 'sent';

  -- 6) Automations + a few runs.
  insert into public.crm_automations
    (org_id, name, trigger_type, trigger_any_form, trigger_stage_id, trigger_form_id, action_type, action_title, action_due_days, action_tag, action_status, enabled)
  values
    (v_org,'Welcome new leads','contact_created',false,null,null,'add_follow_up','Call and introduce ourselves',1,null,null,true),
    (v_org,'Tag website leads','form_submitted',true,null,null,'add_tag',null,null,'from-web',null,true),
    (v_org,'Nudge on proposal','deal_stage',false,s_prop,null,'add_follow_up','Send the proposal reminder',3,null,null,true),
    (v_org,'Won deal becomes customer','deal_won',false,null,null,'set_status',null,null,null,'customer',true);

  insert into public.crm_automation_runs (org_id, automation_id, contact_id, status, detail, created_at)
  select v_org, a.id, ct.id, r.status, r.detail, now() - (r.days || ' days')::interval
  from (values
    ('Welcome new leads','zikri@wongtrading.my','done','Added follow-up: Call and introduce ourselves',2),
    ('Welcome new leads','liyana@abdullahretail.my','done','Added follow-up: Call and introduce ourselves',5),
    ('Tag website leads','syafiq@yusofmotors.my','done','Added tag: from-web',3),
    ('Tag website leads','nuruls@sallehgrocers.my','done','Added tag: from-web',6),
    ('Nudge on proposal','daniel@sridecor.my','done','Added follow-up: Send the proposal reminder',1),
    ('Won deal becomes customer','balqis@printhub.my','skipped','Contact is already a customer',15)
  ) as r(auto_name,email,status,detail,days)
  join public.crm_automations a on a.org_id = v_org and a.name = r.auto_name
  join public.crm_contacts ct on ct.org_id = v_org and ct.email = r.email;

  -- 7) Chatbot: settings, knowledge base, and a few conversations with messages.
  insert into public.crm_chatbot_settings (org_id, bot_name, tone, welcome, handoff_enabled, handoff_after, daily_answer_limit)
  values (v_org, 'Sari', 'friendly', 'Hi! I''m Sari. How can I help you today?', true, 3, 200)
  on conflict (org_id) do nothing;

  insert into public.crm_chatbot_knowledge (org_id, title, body)
  values
    (v_org,'Business hours','We are open Monday to Friday, 9am to 6pm, and Saturday 9am to 1pm. We are closed on public holidays.'),
    (v_org,'What we sell','We supply wholesale household, hardware and festive goods to retailers and businesses across Malaysia.'),
    (v_org,'Delivery areas','We deliver nationwide within Peninsular Malaysia. Orders above RM500 qualify for free delivery within the Klang Valley.'),
    (v_org,'Bulk pricing','Wholesale pricing starts at 10 units. Share your order list and we will send a quote within one working day.'),
    (v_org,'Returns','Unused goods can be returned within 7 days with the original invoice. Perishable items are non-returnable.'),
    (v_org,'Payment methods','We accept online bank transfer, FPX and major cards. Credit terms are available for approved business accounts.');

  insert into public.crm_chatbot_conversations
    (org_id, page_id, secret_hash, status, visitor_messages, contact_id, handoff_name, handoff_email, handoff_phone, handed_off_at, created_at, last_message_at)
  values
    (v_org, null, md5(random()::text||clock_timestamp()::text)||md5(random()::text||clock_timestamp()::text),'open',3,null,null,null,null,null, now()-interval '2 days', now()-interval '2 days')
    returning id into conv1;
  insert into public.crm_chatbot_conversations
    (org_id, page_id, secret_hash, status, visitor_messages, contact_id, handoff_name, handoff_email, handoff_phone, handed_off_at, created_at, last_message_at)
  values
    (v_org, null, md5(random()::text||clock_timestamp()::text)||md5(random()::text||clock_timestamp()::text),'handed_off',4,
     (select id from public.crm_contacts where org_id=v_org and email='maya@hudacollective.my'),'Maya Huda','maya@hudacollective.my','+60123456718', now()-interval '1 day', now()-interval '1 day', now()-interval '1 day')
    returning id into conv2;
  insert into public.crm_chatbot_conversations
    (org_id, page_id, secret_hash, status, visitor_messages, contact_id, handoff_name, handoff_email, handoff_phone, handed_off_at, created_at, last_message_at)
  values
    (v_org, null, md5(random()::text||clock_timestamp()::text)||md5(random()::text||clock_timestamp()::text),'open',2,null,null,null,null,null, now()-interval '6 hours', now()-interval '6 hours')
    returning id into conv3;

  insert into public.crm_chatbot_messages (org_id, conversation_id, role, body, created_at) values
    (v_org, conv1,'visitor','Hi, do you deliver to Penang?', now()-interval '2 days'),
    (v_org, conv1,'bot','Yes, we deliver nationwide within Peninsular Malaysia, including Penang.', now()-interval '2 days' + interval '20 seconds'),
    (v_org, conv1,'visitor','Great, what is the minimum order?', now()-interval '2 days' + interval '2 minutes'),
    (v_org, conv2,'visitor','I need 200 Raya hampers for my company.', now()-interval '1 day'),
    (v_org, conv2,'bot','Happy to help with bulk hampers. May I take your name and email so our team can send a quote?', now()-interval '1 day' + interval '15 seconds'),
    (v_org, conv2,'visitor','Maya Huda, maya@hudacollective.my', now()-interval '1 day' + interval '1 minute'),
    (v_org, conv2,'bot','Thank you, Maya. I have passed this to our team and they will email you a quote shortly.', now()-interval '1 day' + interval '80 seconds'),
    (v_org, conv3,'visitor','Do you offer credit terms for businesses?', now()-interval '6 hours'),
    (v_org, conv3,'bot','Yes, credit terms are available for approved business accounts. I can connect you with our team to set this up.', now()-interval '6 hours' + interval '18 seconds');

  raise notice 'kasturi demo seed complete for org %', v_org;
end $$;

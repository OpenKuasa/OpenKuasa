---
title: Run payroll
description: Create a monthly payroll draft, check and adjust each payslip, then mark the run as paid.
order: 80
ask: How do I run payroll for this month in Lekiu?
screen: /people/payroll
---
On **Payroll**, owners and admins run payroll month by month. A run starts as a draft that employees cannot see. When you mark it as paid, each employee sees their payslip on **My Payslips**.

## Who can do this

Owners and admins. The screen is hidden from everyone else, and shows "This page is for owners and admins of the workspace." if opened. In the demo workspace the screen can be read but nothing can be run or changed.

## Before you start

Each employee needs a **Monthly base salary (RM)** on their record. Someone with no base salary is left out of the run, with the reason "No base salary recorded". See [Add and edit employees](/docs/lekiu/add-and-edit-employees).

## Steps

![The Payroll screen with a draft run, its totals and the payslips table](/docs-media/lekiu/payroll.png)

### Create a draft

1. Open **Lekiu**, then **Payroll** under **Payroll**.
2. Click **Run payroll**.
3. For your first run, pick the **Month**. The first run can be any month up to this one. After that, months follow one another, and the dialog shows the next month.
4. Click **Create draft**. Nobody is paid and employees can't see it yet.

The screen shows "Draft: employees can't see this yet". It also notes overtime claims from earlier months that the run picked up, and active employees who are not on the run.

### Check and adjust payslips

1. In **Payslips**, click an employee's name to open their payslip.
2. To add pay or a deduction, click **Add line**, choose **Earning (adds to gross)** or **Deduction (comes off net)**, type a name and the amount, and click **Save line**. Lines you added can be edited or removed. Lines worked out by the system cannot.
3. EPF, SOCSO, EIS and PCB are proposed by OpenKuasa. The payslip says: "Proposed figures. Check them before marking the run as paid." To use your own amount, type it and click **Save**. The figure is then marked **set by HR**. Click **Reset** to go back to the proposed amount.
4. To take someone off this draft, click **Remove payslip**, then **Confirm**. **Recalculate** would bring it back.

Click **Recalculate** after changing salaries or overtime. It adds payslips for anyone new.

### Mark the run as paid

1. Click **Mark as paid**, then **Confirm**. Employees can now see their payslips.

To change a paid run, click **Undo paid**, then **Confirm**. The payslips go back to draft and employees no longer see them. To throw a draft away, click **Delete draft**, then **Confirm**.

Use the **Month** list at the top to open an earlier run. **Export** is not built yet.

## Common problems

- **"Mark … as paid or delete it before running the next month."** Only one draft at a time.
- **"A payslip's net pay is below zero. Fix it before marking the run as paid."**
- **"An overtime claim on this run has changed. Recalculate first."**
- **"Run payroll for the month after the latest run first."** Months cannot be skipped.
- **"That line is worked out by the system and can't be changed."**
- **"Every month up to now already has a payroll run."** There is no month left to run yet.

## Related

- [Payment vouchers](/docs/lekiu/payment-vouchers)
- [My payslips](/docs/lekiu/my-payslips)
- [Approve or reject overtime](/docs/lekiu/approve-overtime)

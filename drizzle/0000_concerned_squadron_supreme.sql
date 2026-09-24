CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`ride` text NOT NULL,
	`passenger` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`reply` text DEFAULT '' NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bookings_ride_passenger` ON `bookings` (`ride`,`passenger`);--> statement-breakpoint
CREATE INDEX `idx_bookings_passenger` ON `bookings` (`passenger`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`gender` text DEFAULT 'Not specified' NOT NULL,
	`phone` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rides` (
	`id` text PRIMARY KEY NOT NULL,
	`driver` text NOT NULL,
	`origin` text NOT NULL,
	`destination` text NOT NULL,
	`stops` text DEFAULT '' NOT NULL,
	`date` text NOT NULL,
	`time` text NOT NULL,
	`seats` integer NOT NULL,
	`car` text NOT NULL,
	`plate` text NOT NULL,
	`fare` integer,
	`notes` text DEFAULT '' NOT NULL,
	`pickup` text NOT NULL,
	`dropoff` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`lat` real,
	`lng` real,
	`accuracy` real,
	`updated` integer,
	`sharing` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rides_date_status` ON `rides` (`date`,`status`);--> statement-breakpoint
CREATE INDEX `idx_rides_driver` ON `rides` (`driver`);--> statement-breakpoint
CREATE TABLE `shares` (
	`token` text PRIMARY KEY NOT NULL,
	`ride` text NOT NULL,
	`owner` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_shares_ride_owner` ON `shares` (`ride`,`owner`);
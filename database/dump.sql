CREATE TABLE `config` (
  `id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'primary key',
  `created_time` datetime DEFAULT NULL COMMENT 'created time',
  `updated_time` datetime DEFAULT NULL COMMENT 'updated time',
  `username` varchar(255) DEFAULT NULL,
  `hostname` varchar(255) DEFAULT NULL,
  `inventory_path` varchar(255) DEFAULT NULL,
  `vhd_path` varchar(255) DEFAULT NULL,
  `ldap_url` varchar(255) DEFAULT NULL,
  `base_dn` varchar(255) DEFAULT NULL,
  `refresh_interval` int(11) DEFAULT '180',
  PRIMARY KEY (`id`),
  UNIQUE KEY `id` (`id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `hostname` (`hostname`),
  UNIQUE KEY `inventory_path` (`hostname`),
  UNIQUE KEY `vhd_path` (`hostname`),
  UNIQUE KEY `ldap_url` (`ldap_url`),
  UNIQUE KEY `base_dn` (`base_dn`),
  UNIQUE KEY `refresh_interval` (`refresh_interval`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8;

CREATE TABLE `img` (
  `id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'primary key',
  `created_time` datetime DEFAULT NULL COMMENT 'created time',
  `updated_time` datetime DEFAULT NULL COMMENT 'updated time',
  `images` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `id` (`id`),
  UNIQUE KEY `images` (`images`)
) ENGINE=InnoDB AUTO_INCREMENT=155 DEFAULT CHARSET=utf8;

CREATE TABLE `logs` (
  `id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'primary key',
  `created_time` datetime DEFAULT NULL COMMENT 'created time',
  `updated_time` datetime DEFAULT NULL COMMENT 'updated time',
  `logs` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8;

CREATE TABLE `switch` (
  `id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'primary key',
  `created_time` datetime DEFAULT NULL COMMENT 'created time',
  `updated_time` datetime DEFAULT NULL COMMENT 'updated time',
  `switch` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `switch` (`switch`)
) ENGINE=InnoDB AUTO_INCREMENT=185 DEFAULT CHARSET=utf8;


CREATE TABLE `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'primary key',
  `created_time` datetime DEFAULT NULL COMMENT 'created time',
  `updated_time` datetime DEFAULT NULL COMMENT 'updated time',
  `username` varchar(255) DEFAULT NULL,
  `password` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `id` (`id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `password` (`password`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8;

CREATE TABLE `VMS_UNIQUE` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `created_time` datetime DEFAULT NULL,
  `updated_time` datetime DEFAULT NULL,
  `VMNAME` varchar(255) NOT NULL,
  `VMSTATE` varchar(255) NOT NULL,
  `VMCPUUSAGE` varchar(255) NOT NULL,
  `VMUPTIME` varchar(8) NOT NULL,
  `VMID` varchar(8) NOT NULL,
  `MEMORYSTARTUP` varchar(255) NOT NULL,
  `CPU` varchar(255) NOT NULL,
  `IP` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `id` (`id`),
  UNIQUE KEY `VMID` (`VMID`)
) ENGINE=InnoDB AUTO_INCREMENT=12857 DEFAULT CHARSET=utf8;
